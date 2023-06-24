import { SlackAppEnv } from "./app-env";
import { parseRequestBody } from "./request/request-parser";
import { verifySlackRequest } from "./request/request-verification";
import { AckResponse, SlackHandler } from "./handler/handler";
import { SlackRequestBody } from "./request/request-body";
import {
  PreAuthorizeSlackMiddlwareRequest,
  SlackRequestWithRespond,
  SlackMiddlwareRequest,
  SlackRequestWithOptionalRespond,
  SlackRequest,
  SlackRequestWithChannelId,
} from "./request/request";
import { SlashCommand } from "./request/payload/slash-command";
import { toCompleteResponse } from "./response/response";
import {
  SlackEvent,
  AnySlackEvent,
  AnySlackEventWithChannelId,
} from "./request/payload/event";
import { ResponseUrlSender, SlackAPIClient } from "slack-web-api-client";
import {
  builtBaseContext,
  SlackAppContext,
  SlackAppContextWithChannelId,
  SlackAppContextWithRespond,
} from "./context/context";
import { PreAuthorizeMiddleware, Middleware } from "./middleware/middleware";
import { isDebugLogEnabled, prettyPrint } from "slack-web-api-client";
import { Authorize } from "./authorization/authorize";
import { AuthorizeResult } from "./authorization/authorize-result";
import {
  ignoringSelfEvents,
  urlVerification,
} from "./middleware/built-in-middleware";
import { ConfigError } from "./errors";
import { GlobalShortcut } from "./request/payload/global-shortcut";
import { MessageShortcut } from "./request/payload/message-shortcut";
import {
  BlockAction,
  BlockElementAction,
  BlockElementTypes,
} from "./request/payload/block-action";
import { ViewSubmission } from "./request/payload/view-submission";
import { ViewClosed } from "./request/payload/view-closed";
import { BlockSuggestion } from "./request/payload/block-suggestion";
import {
  OptionsAckResponse,
  SlackOptionsHandler,
} from "./handler/options-handler";
import { SlackViewHandler, ViewAckResponse } from "./handler/view-handler";
import {
  MessageAckResponse,
  SlackMessageHandler,
} from "./handler/message-handler";
import { singleTeamAuthorize } from "./authorization/single-team-authorize";
import { ExecutionContext } from "./execution-context";
import { PayloadType } from "./request/payload-types";
import { isPostedMessageEvent } from "./utility/message-events";

export interface SlackAppOptions<E extends SlackAppEnv> {
  env: E;
  authorize?: Authorize<E>;
  routes?: {
    events: string;
  };
  socketMode?: boolean;
}

export class SlackApp<E extends SlackAppEnv> {
  public env: E;
  public client: SlackAPIClient;
  public authorize: Authorize<E>;
  public routes: { events: string | undefined };
  public signingSecret: string;
  public socketMode: boolean;
  public appLevelToken: string | undefined;

  // deno-lint-ignore no-explicit-any
  public preAuthorizeMiddleware: PreAuthorizeMiddleware<any>[] = [
    urlVerification,
  ];

  // deno-lint-ignore no-explicit-any
  public postAuthorizeMiddleware: Middleware<any>[] = [ignoringSelfEvents];

  #slashCommands: ((
    body: SlackRequestBody
  ) => SlackMessageHandler<E, SlashCommand> | null)[] = [];
  #events: ((
    body: SlackRequestBody
  ) => SlackHandler<E, SlackEvent<string>> | null)[] = [];
  #globalShorcuts: ((
    body: SlackRequestBody
  ) => SlackHandler<E, GlobalShortcut> | null)[] = [];
  #messageShorcuts: ((
    body: SlackRequestBody
  ) => SlackHandler<E, MessageShortcut> | null)[] = [];
  #blockActions: ((body: SlackRequestBody) => SlackHandler<
    E,
    // deno-lint-ignore no-explicit-any
    BlockAction<any>
  > | null)[] = [];
  #blockSuggestions: ((
    body: SlackRequestBody
  ) => SlackOptionsHandler<E, BlockSuggestion> | null)[] = [];
  #viewSubmissions: ((
    body: SlackRequestBody
  ) => SlackViewHandler<E, ViewSubmission> | null)[] = [];
  #viewClosed: ((
    body: SlackRequestBody
  ) => SlackViewHandler<E, ViewClosed> | null)[] = [];

  constructor(options: SlackAppOptions<E>) {
    if (
      options.env.SLACK_BOT_TOKEN === undefined &&
      (options.authorize === undefined ||
        options.authorize === singleTeamAuthorize)
    ) {
      throw new ConfigError(
        "When you don't pass env.SLACK_BOT_TOKEN, your own authorize function, which supplies a valid token to use, needs to be passed instead."
      );
    }
    this.env = options.env;
    this.client = new SlackAPIClient(options.env.SLACK_BOT_TOKEN, {
      logLevel: this.env.SLACK_LOGGING_LEVEL,
    });
    this.socketMode = options.socketMode ?? false;
    if (this.socketMode) {
      if (!this.env.SLACK_APP_TOKEN) {
        throw new ConfigError("env.SLACK_APP_TOKEN must be set!");
      }
      this.appLevelToken = this.env.SLACK_APP_TOKEN;
      this.signingSecret = ""; // won't be used
    } else {
      if (!this.env.SLACK_SIGNING_SECRET) {
        throw new ConfigError("env.SLACK_SIGNING_SECRET must be set!");
      }
      this.signingSecret = this.env.SLACK_SIGNING_SECRET;
    }

    this.authorize = options.authorize ?? singleTeamAuthorize;
    if (this.socketMode && options.routes) {
      console.error(
        "Note that the `routes` parameter will be ignored when enabling Socket Mode"
      );
    }
    this.routes = { events: options.routes?.events };
  }

  beforeAuthorize(middleware: PreAuthorizeMiddleware<E>): SlackApp<E> {
    this.preAuthorizeMiddleware.push(middleware);
    return this;
  }

  middleware(middleware: Middleware<E>): SlackApp<E> {
    return this.afterAuthorize(middleware);
  }

  use(middleware: Middleware<E>): SlackApp<E> {
    return this.afterAuthorize(middleware);
  }

  afterAuthorize(middleware: Middleware<E>): SlackApp<E> {
    this.postAuthorizeMiddleware.push(middleware);
    return this;
  }

  command(
    pattern: StringOrRegExp,
    ack: (
      req: SlackRequestWithRespond<E, SlashCommand>
    ) => Promise<MessageAckResponse>,
    lazy: (
      req: SlackRequestWithRespond<E, SlashCommand>
    ) => Promise<void> = noopLazyListener
  ): SlackApp<E> {
    const handler: SlackMessageHandler<E, SlashCommand> = { ack, lazy };
    this.#slashCommands.push((body) => {
      if (body.type || !body.command) {
        return null;
      }
      if (typeof pattern === "string" && body.command === pattern) {
        return handler;
      } else if (
        typeof pattern === "object" &&
        pattern instanceof RegExp &&
        body.command.match(pattern)
      ) {
        return handler;
      }
      return null;
    });
    return this;
  }

  event<Type extends string>(
    event: Type,
    lazy: (req: EventRequest<E, Type>) => Promise<void>
  ): SlackApp<E> {
    this.#events.push((body) => {
      if (body.type !== PayloadType.EventsAPI || !body.event) {
        return null;
      }
      if (body.event.type === event) {
        // deno-lint-ignore require-await
        return { ack: async () => "", lazy };
      }
      return null;
    });
    return this;
  }

  anyMessage(lazy: MessageEventHandler<E>): SlackApp<E> {
    return this.message(undefined, lazy);
  }

  message(
    pattern: MessageEventPattern,
    lazy: MessageEventHandler<E>
  ): SlackApp<E> {
    this.#events.push((body) => {
      if (
        body.type !== PayloadType.EventsAPI ||
        !body.event ||
        body.event.type !== "message"
      ) {
        return null;
      }
      if (isPostedMessageEvent(body.event)) {
        let matched = true;
        if (pattern !== undefined) {
          if (typeof pattern === "string") {
            matched = body.event.text!.includes(pattern);
          }
          if (typeof pattern === "object") {
            matched = body.event.text!.match(pattern) !== null;
          }
        }
        if (matched) {
          // deno-lint-ignore require-await
          return { ack: async (_: EventRequest<E, "message">) => "", lazy };
        }
      }
      return null;
    });
    return this;
  }

  shortcut(
    callbackId: StringOrRegExp,
    ack: (
      req:
        | SlackRequest<E, GlobalShortcut>
        | SlackRequestWithRespond<E, MessageShortcut>
    ) => Promise<AckResponse>,
    lazy: (
      req:
        | SlackRequest<E, GlobalShortcut>
        | SlackRequestWithRespond<E, MessageShortcut>
    ) => Promise<void> = noopLazyListener
  ): SlackApp<E> {
    return this.globalShortcut(callbackId, ack, lazy).messageShortcut(
      callbackId,
      ack,
      lazy
    );
  }

  globalShortcut(
    callbackId: StringOrRegExp,
    ack: (req: SlackRequest<E, GlobalShortcut>) => Promise<AckResponse>,
    lazy: (
      req: SlackRequest<E, GlobalShortcut>
    ) => Promise<void> = noopLazyListener
  ): SlackApp<E> {
    const handler: SlackHandler<E, GlobalShortcut> = { ack, lazy };
    this.#globalShorcuts.push((body) => {
      if (body.type !== PayloadType.GlobalShortcut || !body.callback_id) {
        return null;
      }
      if (typeof callbackId === "string" && body.callback_id === callbackId) {
        return handler;
      } else if (
        typeof callbackId === "object" &&
        callbackId instanceof RegExp &&
        body.callback_id.match(callbackId)
      ) {
        return handler;
      }
      return null;
    });
    return this;
  }

  messageShortcut(
    callbackId: StringOrRegExp,
    ack: (
      req: SlackRequestWithRespond<E, MessageShortcut>
    ) => Promise<AckResponse>,
    lazy: (
      req: SlackRequestWithRespond<E, MessageShortcut>
    ) => Promise<void> = noopLazyListener
  ): SlackApp<E> {
    const handler: SlackHandler<E, MessageShortcut> = { ack, lazy };
    this.#messageShorcuts.push((body) => {
      if (body.type !== PayloadType.MessageShortcut || !body.callback_id) {
        return null;
      }
      if (typeof callbackId === "string" && body.callback_id === callbackId) {
        return handler;
      } else if (
        typeof callbackId === "object" &&
        callbackId instanceof RegExp &&
        body.callback_id.match(callbackId)
      ) {
        return handler;
      }
      return null;
    });
    return this;
  }

  action<
    T extends BlockElementTypes,
    A extends BlockAction<BlockElementAction<T>> = BlockAction<
      BlockElementAction<T>
    >
  >(
    constraints:
      | StringOrRegExp
      | { type: T; block_id?: string; action_id: string },
    ack: (req: SlackRequestWithOptionalRespond<E, A>) => Promise<AckResponse>,
    lazy: (
      req: SlackRequestWithOptionalRespond<E, A>
    ) => Promise<void> = noopLazyListener
  ): SlackApp<E> {
    const handler: SlackHandler<E, A> = { ack, lazy };
    this.#blockActions.push((body) => {
      if (
        body.type !== PayloadType.BlockAction ||
        !body.actions ||
        !body.actions[0]
      ) {
        return null;
      }
      const action = body.actions[0];
      if (typeof constraints === "string" && action.action_id === constraints) {
        return handler;
      } else if (typeof constraints === "object") {
        if (constraints instanceof RegExp) {
          if (action.action_id.match(constraints)) {
            return handler;
          }
        } else if (constraints.type) {
          if (action.type === constraints.type) {
            if (action.action_id === constraints.action_id) {
              if (
                constraints.block_id &&
                action.block_id !== constraints.block_id
              ) {
                return null;
              }
              return handler;
            }
          }
        }
      }
      return null;
    });
    return this;
  }

  options(
    constraints: StringOrRegExp | { block_id?: string; action_id: string },
    ack: (req: SlackRequest<E, BlockSuggestion>) => Promise<OptionsAckResponse>
  ): SlackApp<E> {
    // Note that block_suggestion response must be done within 3 seconds.
    // So, we don't support the lazy handler for it.
    const handler: SlackOptionsHandler<E, BlockSuggestion> = { ack };
    this.#blockSuggestions.push((body) => {
      if (body.type !== PayloadType.BlockSuggestion || !body.action_id) {
        return null;
      }
      if (typeof constraints === "string" && body.action_id === constraints) {
        return handler;
      } else if (typeof constraints === "object") {
        if (constraints instanceof RegExp) {
          if (body.action_id.match(constraints)) {
            return handler;
          }
        } else {
          if (body.action_id === constraints.action_id) {
            if (body.block_id && body.block_id !== constraints.block_id) {
              return null;
            }
            return handler;
          }
        }
      }
      return null;
    });
    return this;
  }

  view(
    callbackId: StringOrRegExp,
    ack: (
      req:
        | SlackRequestWithOptionalRespond<E, ViewSubmission>
        | SlackRequest<E, ViewClosed>
    ) => Promise<ViewAckResponse>,
    lazy: (
      req:
        | SlackRequestWithOptionalRespond<E, ViewSubmission>
        | SlackRequest<E, ViewClosed>
    ) => Promise<void> = noopLazyListener
  ): SlackApp<E> {
    return this.viewSubmission(callbackId, ack, lazy).viewClosed(
      callbackId,
      ack,
      lazy
    );
  }

  viewSubmission(
    callbackId: StringOrRegExp,
    ack: (
      req: SlackRequestWithOptionalRespond<E, ViewSubmission>
    ) => Promise<ViewAckResponse>,
    lazy: (
      req: SlackRequestWithOptionalRespond<E, ViewSubmission>
    ) => Promise<void> = noopLazyListener
  ): SlackApp<E> {
    const handler: SlackViewHandler<E, ViewSubmission> = { ack, lazy };
    this.#viewSubmissions.push((body) => {
      if (body.type !== PayloadType.ViewSubmission || !body.view) {
        return null;
      }
      if (
        typeof callbackId === "string" &&
        body.view.callback_id === callbackId
      ) {
        return handler;
      } else if (
        typeof callbackId === "object" &&
        callbackId instanceof RegExp &&
        body.view.callback_id.match(callbackId)
      ) {
        return handler;
      }
      return null;
    });
    return this;
  }

  viewClosed(
    callbackId: StringOrRegExp,
    ack: (req: SlackRequest<E, ViewClosed>) => Promise<ViewAckResponse>,
    lazy: (req: SlackRequest<E, ViewClosed>) => Promise<void> = noopLazyListener
  ): SlackApp<E> {
    const handler: SlackViewHandler<E, ViewClosed> = { ack, lazy };
    this.#viewClosed.push((body) => {
      if (body.type !== PayloadType.ViewClosed || !body.view) {
        return null;
      }
      if (
        typeof callbackId === "string" &&
        body.view.callback_id === callbackId
      ) {
        return handler;
      } else if (
        typeof callbackId === "object" &&
        callbackId instanceof RegExp &&
        body.view.callback_id.match(callbackId)
      ) {
        return handler;
      }
      return null;
    });
    return this;
  }

  async run(request: Request, ctx: ExecutionContext): Promise<Response> {
    return await this.handleEventRequest(request, ctx);
  }

  readonly withSocketMode = {
    async connect(): Promise<void> {},
  };

  async handleEventRequest(
    request: Request,
    ctx: ExecutionContext
  ): Promise<Response> {
    // If the routes.events is missing, any URLs can work for handing requests from Slack
    if (this.routes.events) {
      const { pathname } = new URL(request.url);
      if (pathname !== this.routes.events) {
        return new Response("Not found", { status: 404 });
      }
    }

    // To avoid the following warning by Cloudflware, parse the body as Blob first
    // Called .text() on an HTTP body which does not appear to be text ..
    const blobRequestBody = await request.blob();
    // We can safely assume the incoming request body is always text data
    const rawBody: string = await blobRequestBody.text();

    // For Request URL verification
    if (rawBody.includes("ssl_check=")) {
      // Slack does not send the x-slack-signature header for this pattern.
      // Thus, we need to check the pattern before verifying a request.
      const bodyParams = new URLSearchParams(rawBody);
      if (bodyParams.get("ssl_check") === "1" && bodyParams.get("token")) {
        return new Response("", { status: 200 });
      }
    }

    // Verify the request headers and body
    let verified = this.socketMode;
    if (!verified) {
      verified = await verifySlackRequest(
        this.signingSecret,
        request.headers,
        rawBody
      );
    }
    if (verified) {
      // deno-lint-ignore no-explicit-any
      const body: Record<string, any> = await parseRequestBody(
        request.headers,
        rawBody
      );
      let retryNum: number | undefined = undefined;
      try {
        const retryNumHeader = request.headers.get("x-slack-retry-num");
        if (retryNumHeader) {
          retryNum = Number.parseInt(retryNumHeader);
        } else if (this.socketMode) {
          retryNum = Number.parseInt(body.retry_attempt);
        }
        // deno-lint-ignore no-unused-vars
      } catch (e) {
        // Ignore an exception here
      }
      const retryReason =
        request.headers.get("x-slack-retry-reason") ?? body.retry_reason;
      const preAuthorizeRequest: PreAuthorizeSlackMiddlwareRequest<E> = {
        body,
        rawBody,
        retryNum,
        retryReason,
        context: builtBaseContext(body),
        env: this.env,
        headers: request.headers,
      };
      if (isDebugLogEnabled(this.env.SLACK_LOGGING_LEVEL)) {
        console.log(`*** Received request body ***\n ${prettyPrint(body)}`);
      }
      for (const middlware of this.preAuthorizeMiddleware) {
        const response = await middlware(preAuthorizeRequest);
        if (response) {
          return toCompleteResponse(response);
        }
      }
      const authorizeResult: AuthorizeResult = await this.authorize(
        preAuthorizeRequest
      );
      const authorizedContext: SlackAppContext = {
        ...preAuthorizeRequest.context,
        authorizeResult,
        client: new SlackAPIClient(authorizeResult.botToken, {
          logLevel: this.env.SLACK_LOGGING_LEVEL,
        }),
        botToken: authorizeResult.botToken,
        botId: authorizeResult.botId,
        botUserId: authorizeResult.botUserId,
        userToken: authorizeResult.userToken,
      };
      if (authorizedContext.channelId) {
        const context = authorizedContext as SlackAppContextWithChannelId;
        const client = new SlackAPIClient(context.botToken);
        context.say = async (params) =>
          await client.chat.postMessage({
            channel: context.channelId,
            ...params,
          });
      }
      if (authorizedContext.responseUrl) {
        const responseUrl = authorizedContext.responseUrl;
        // deno-lint-ignore require-await
        (authorizedContext as SlackAppContextWithRespond).respond = async (
          params
        ) => {
          return new ResponseUrlSender(responseUrl).call(params);
        };
      }

      const baseRequest: SlackMiddlwareRequest<E> = {
        ...preAuthorizeRequest,
        context: authorizedContext,
      };
      for (const middlware of this.postAuthorizeMiddleware) {
        const response = await middlware(baseRequest);
        if (response) {
          return toCompleteResponse(response);
        }
      }

      const payload = body as SlackRequestBody;

      if (body.type === PayloadType.EventsAPI) {
        // Events API
        const slackRequest: SlackRequest<E, SlackEvent<string>> = {
          payload: body.event,
          ...baseRequest,
        };
        for (const matcher of this.#events) {
          const handler = matcher(payload);
          if (handler) {
            ctx.waitUntil(handler.lazy(slackRequest));
            const slackResponse = await handler.ack(slackRequest);
            if (isDebugLogEnabled(this.env.SLACK_LOGGING_LEVEL)) {
              console.log(
                `*** Slack response ***\n${prettyPrint(slackResponse)}`
              );
            }
            return toCompleteResponse(slackResponse);
          }
        }
      } else if (!body.type && body.command) {
        // Slash commands
        const slackRequest: SlackRequest<E, SlashCommand> = {
          payload: body as SlashCommand,
          ...baseRequest,
        };
        for (const matcher of this.#slashCommands) {
          const handler = matcher(payload);
          if (handler) {
            ctx.waitUntil(handler.lazy(slackRequest));
            const slackResponse = await handler.ack(slackRequest);
            if (isDebugLogEnabled(this.env.SLACK_LOGGING_LEVEL)) {
              console.log(
                `*** Slack response ***\n${prettyPrint(slackResponse)}`
              );
            }
            return toCompleteResponse(slackResponse);
          }
        }
      } else if (body.type === PayloadType.GlobalShortcut) {
        // Global shortcuts
        const slackRequest: SlackRequest<E, GlobalShortcut> = {
          payload: body as GlobalShortcut,
          ...baseRequest,
        };
        for (const matcher of this.#globalShorcuts) {
          const handler = matcher(payload);
          if (handler) {
            ctx.waitUntil(handler.lazy(slackRequest));
            const slackResponse = await handler.ack(slackRequest);
            if (isDebugLogEnabled(this.env.SLACK_LOGGING_LEVEL)) {
              console.log(
                `*** Slack response ***\n${prettyPrint(slackResponse)}`
              );
            }
            return toCompleteResponse(slackResponse);
          }
        }
      } else if (body.type === PayloadType.MessageShortcut) {
        // Message shortcuts
        const slackRequest: SlackRequest<E, MessageShortcut> = {
          payload: body as MessageShortcut,
          ...baseRequest,
        };
        for (const matcher of this.#messageShorcuts) {
          const handler = matcher(payload);
          if (handler) {
            ctx.waitUntil(handler.lazy(slackRequest));
            const slackResponse = await handler.ack(slackRequest);
            if (isDebugLogEnabled(this.env.SLACK_LOGGING_LEVEL)) {
              console.log(
                `*** Slack response ***\n${prettyPrint(slackResponse)}`
              );
            }
            return toCompleteResponse(slackResponse);
          }
        }
      } else if (body.type === PayloadType.BlockAction) {
        // Block actions
        // deno-lint-ignore no-explicit-any
        const slackRequest: SlackRequest<E, BlockAction<any>> = {
          // deno-lint-ignore no-explicit-any
          payload: body as BlockAction<any>,
          ...baseRequest,
        };
        for (const matcher of this.#blockActions) {
          const handler = matcher(payload);
          if (handler) {
            ctx.waitUntil(handler.lazy(slackRequest));
            const slackResponse = await handler.ack(slackRequest);
            if (isDebugLogEnabled(this.env.SLACK_LOGGING_LEVEL)) {
              console.log(
                `*** Slack response ***\n${prettyPrint(slackResponse)}`
              );
            }
            return toCompleteResponse(slackResponse);
          }
        }
      } else if (body.type === PayloadType.BlockSuggestion) {
        // Block suggestions
        const slackRequest: SlackRequest<E, BlockSuggestion> = {
          payload: body as BlockSuggestion,
          ...baseRequest,
        };
        for (const matcher of this.#blockSuggestions) {
          const handler = matcher(payload);
          if (handler) {
            // Note that the only way to respond to a block_suggestion request
            // is to send an HTTP response with options/option_groups.
            // Thus, we don't support lazy handlers for this pattern.
            const slackResponse = await handler.ack(slackRequest);
            if (isDebugLogEnabled(this.env.SLACK_LOGGING_LEVEL)) {
              console.log(
                `*** Slack response ***\n${prettyPrint(slackResponse)}`
              );
            }
            return toCompleteResponse(slackResponse);
          }
        }
      } else if (body.type === PayloadType.ViewSubmission) {
        // View submissions
        const slackRequest: SlackRequest<E, ViewSubmission> = {
          payload: body as ViewSubmission,
          ...baseRequest,
        };
        for (const matcher of this.#viewSubmissions) {
          const handler = matcher(payload);
          if (handler) {
            ctx.waitUntil(handler.lazy(slackRequest));
            const slackResponse = await handler.ack(slackRequest);
            if (isDebugLogEnabled(this.env.SLACK_LOGGING_LEVEL)) {
              console.log(
                `*** Slack response ***\n${prettyPrint(slackResponse)}`
              );
            }
            return toCompleteResponse(slackResponse);
          }
        }
      } else if (body.type === PayloadType.ViewClosed) {
        // View closed
        const slackRequest: SlackRequest<E, ViewClosed> = {
          payload: body as ViewClosed,
          ...baseRequest,
        };
        for (const matcher of this.#viewClosed) {
          const handler = matcher(payload);
          if (handler) {
            ctx.waitUntil(handler.lazy(slackRequest));
            const slackResponse = await handler.ack(slackRequest);
            if (isDebugLogEnabled(this.env.SLACK_LOGGING_LEVEL)) {
              console.log(
                `*** Slack response ***\n${prettyPrint(slackResponse)}`
              );
            }
            return toCompleteResponse(slackResponse);
          }
        }
      }
      console.log(
        `*** No listener found ***\n${prettyPrint(baseRequest.body)}`
      );
      return new Response("No listener found", { status: 404 });
    }
    return new Response("Invalid signature", { status: 401 });
  }
}

export type StringOrRegExp = string | RegExp;

export type EventRequest<E extends SlackAppEnv, T> = Extract<
  AnySlackEventWithChannelId,
  { type: T }
> extends never
  ? SlackRequest<E, Extract<AnySlackEvent, { type: T }>>
  : SlackRequestWithChannelId<
      E,
      Extract<AnySlackEventWithChannelId, { type: T }>
    >;

export type MessageEventPattern = string | RegExp | undefined;

export type MessageEventRequest<
  E extends SlackAppEnv,
  ST extends string | undefined
> = SlackRequestWithChannelId<
  E,
  Extract<AnySlackEventWithChannelId, { subtype: ST }>
>;

export type MessageEventSubtypes =
  | undefined
  | "bot_message"
  | "thread_broadcast"
  | "file_share";

export type MessageEventHandler<E extends SlackAppEnv> = (
  req: MessageEventRequest<E, MessageEventSubtypes>
) => Promise<void>;

export const noopLazyListener = async () => {};
