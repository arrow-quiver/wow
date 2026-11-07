// One import for every page: the htm template tag bound to Preact, render, and the hooks.
//   import { html, useState, useEffect } from '../lib/html.js';
//   html`<${Card} title="Raids">${rows}<//>`
import {
  h, render, Fragment, Component, createContext, createRef, cloneElement, toChildArray, isValidElement,
} from 'preact';
import {
  useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useReducer, useContext, useId,
  useErrorBoundary, useImperativeHandle,
} from 'preact/hooks';
import htm from 'htm';

export const html = htm.bind(h);

export {
  h, render, Fragment, Component, createContext, createRef, cloneElement, toChildArray, isValidElement,
  useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useReducer, useContext, useId,
  useErrorBoundary, useImperativeHandle,
};

// Joins class names, skipping falsy values: cx('btn', busy && 'is-busy') → "btn is-busy".
export function cx(...parts) {
  const out = [];
  for (const p of parts) if (p) out.push(p);
  return out.join(' ') || undefined;
}
