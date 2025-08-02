// Base class for all Ignite plugins
export abstract class BasePlugin {
  constructor(public name: string) {}

  abstract getInfo(): { name: string; version: string };
}
