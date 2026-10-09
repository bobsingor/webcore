'use strict';

// webcore override (ADR-0012): instead of bundling undici, Node's fetch-related globals are the
// host's native implementations, captured before Node's bootstrap installs its own globals.
// Outbound requests are subject to CORS.
const { hostGlobals } = internalBinding('webcore');

module.exports = {
  fetch: hostGlobals.fetch,
  FormData: hostGlobals.FormData,
  Headers: hostGlobals.Headers,
  Request: hostGlobals.Request,
  Response: hostGlobals.Response,
  WebSocket: hostGlobals.WebSocket,
  EventSource: hostGlobals.EventSource,
  MessageEvent: hostGlobals.MessageEvent,
  CloseEvent: hostGlobals.CloseEvent,
};
