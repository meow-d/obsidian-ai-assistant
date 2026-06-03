const isDev = process.env.NODE_ENV !== "production";
const noop = () => {};

export const log: typeof console.log = isDev ? console.log.bind(console) : (noop as typeof console.log);
export const warn: typeof console.warn = isDev ? console.warn.bind(console) : (noop as typeof console.warn);
export const error: typeof console.error = isDev ? console.error.bind(console) : (noop as typeof console.error);
