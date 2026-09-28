/**
 * @wa/core — pure, dependency-light logic shared by the web app and the worker.
 *
 * Nothing in here talks to the database, the network or WhatsApp. That keeps
 * it trivially testable and lets the browser import the same rendering and
 * safety rules the worker enforces.
 */

export * from './env';
export * from './crypto';
export * from './safety';
export * from './phone';
export * from './logger';
export * from './template';
