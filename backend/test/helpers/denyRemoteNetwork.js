const net = require('node:net');
const tls = require('node:tls');

function hostFromArguments(args) {
  if (args[0] && typeof args[0] === 'object') return args[0].host || args[0].hostname;
  if (typeof args[0] === 'number') return args[1];
  return null;
}

function assertLoopback(args) {
  const host = String(hostFromArguments(args) || '').toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    const error = new Error('test_remote_network_blocked');
    error.code = 'test_remote_network_blocked';
    throw error;
  }
}

function wrap(original) {
  return function loopbackOnly(...args) {
    assertLoopback(args);
    return original.apply(this, args);
  };
}

net.connect = wrap(net.connect);
net.createConnection = net.connect;
tls.connect = wrap(tls.connect);
