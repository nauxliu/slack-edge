export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class AuthorizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizeError";
  }
}

export class SocketModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocketModeError";
  }
}
