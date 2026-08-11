/* Global types for the Spicetify xpui runtime. This file has no imports/exports
   so its `declare global`/namespace declarations apply project-wide. */

declare namespace JSX {
  interface IntrinsicElements {
    [elemName: string]: {
      [key: string]: unknown;
      children?: unknown;
      className?: string;
      onClick?: (e: { target: EventTarget & { value?: string } }) => void;
      onChange?: (e: { target: EventTarget & { value?: string } }) => void;
      src?: string;
      alt?: string;
      title?: string;
      min?: number;
      max?: number;
      step?: number;
      value?: number | string;
      style?: Record<string, string | number>;
    };
  }
}

declare const React: {
  createElement: (...args: unknown[]) => unknown;
  Fragment: unknown;
  useState: <T>(init: T) => [T, (v: T | ((p: T) => T)) => void];
  useEffect: (fn: () => void | (() => void), deps?: unknown[]) => void;
  useRef: <T>(init: T) => { current: T };
};

declare const ReactDOM: {
  createRoot: (el: Element) => { render: (el: unknown) => void };
};

declare const Spicetify: {
  React: typeof React;
  ReactDOM: typeof ReactDOM;
  Platform: {
    History: {
      location: { pathname: string };
      push: (path: string, state?: unknown) => void;
    };
  };
};
