'use strict';

// webcore override (ADR-0012): instead of bundling undici, Node's fetch-related globals are the
// host's native implementations, captured before Node's bootstrap installs its own globals.
// Outbound requests are subject to CORS.
const { hostGlobals } = internalBinding('webcore');

// MessagePort's DOM-style listeners (port.onmessage, addEventListener) and BroadcastChannel build
// their events with createFastMessageEvent. The host's MessageEvent can't carry Node's ports or
// work with Node's EventTarget, so these are Node Events.
let MessageEventClass;
function createFastMessageEvent(type, init = {}) {
  if (MessageEventClass === undefined) {
    const { Event } = require('internal/event_target');
    MessageEventClass = class MessageEvent extends Event {
      #data;
      #ports;
      constructor(type, init = {}) {
        super(type, init);
        this.#data = init.data ?? null;
        this.#ports = Object.freeze([...(init.ports ?? [])]);
      }
      get data() { return this.#data; }
      get ports() { return this.#ports; }
      get origin() { return ''; }
      get lastEventId() { return ''; }
      get source() { return null; }
    };
  }
  return new MessageEventClass(type, init);
}

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
  createFastMessageEvent,
};
