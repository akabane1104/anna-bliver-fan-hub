const dgram = require('node:dgram');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

async function withNetworkGuard(work) {
  const calls = [];
  const restorations = [];
  const replace = (target, key, label) => {
    const original = target[key];
    restorations.push(() => {
      target[key] = original;
    });
    target[key] = function blockedNetworkCall() {
      calls.push(label);
      const error = new Error('Network access blocked by offline test');
      error.code = 'offline_network_forbidden';
      throw error;
    };
  };

  replace(globalThis, 'fetch', 'fetch');
  replace(net, 'connect', 'net.connect');
  replace(net, 'createConnection', 'net.createConnection');
  replace(net.Socket.prototype, 'connect', 'net.Socket.connect');
  replace(http, 'request', 'http.request');
  replace(http, 'get', 'http.get');
  replace(https, 'request', 'https.request');
  replace(https, 'get', 'https.get');
  replace(dns, 'lookup', 'dns.lookup');
  replace(dns, 'resolve', 'dns.resolve');
  replace(dgram, 'createSocket', 'dgram.createSocket');

  try {
    return await work(calls);
  } finally {
    for (const restore of restorations.reverse()) restore();
  }
}

module.exports = {
  withNetworkGuard
};
