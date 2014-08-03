module.exports = Socket

var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')
var once = require('once')

var RECONNECT_TIMEOUT = 5000

inherits(Socket, EventEmitter)

function Socket (url, opts) {
  EventEmitter.call(this)
  opts = opts || {}
  this._url = url
  this._reconnectTimeout = opts.reconnectTimeout || RECONNECT_TIMEOUT
  this._init()
}

Socket.prototype._init = function () {
  this._errored = false
  this._ws = new WebSocket(this._url)
  this._ws.onopen = this._onopen.bind(this)
  this._ws.onmessage = this._onmessage.bind(this)
  this._ws.onclose = this._onclose.bind(this)
  this._ws.onerror = once(this._onerror.bind(this))
}

Socket.prototype._onopen = function () {
  this.emit('ready')
}

Socket.prototype._onerror = function (err) {
  this._errored = true

  // On error, close socket...
  this.close()

  // ...and try to reconnect after a timeout
  setTimeout(this._init.bind(this), this._reconnectTimeout)
  this.emit('warning', err)
}

Socket.prototype.close = function () {
  try {
    this._ws.close()
  } catch (err) {
    this._onclose()
  }
}

Socket.prototype._onmessage = function (event) {
  console.log('[websocket receive] ' + event.data)
  try {
    var message = JSON.parse(event.data)
    this.emit('message', message)
  } catch (err) {
    this.emit('message', event.data)
  }
}

Socket.prototype._onclose = function () {
  if (this._ws) {
    this._ws.onopen = null
    this._ws.onerror = null
    this._ws.onmessage = null
    this._ws.onclose = null
  }
  this._ws = null
  if (!this._errored) this.emit('close')
}

Socket.prototype.send = function (message) {
  if (this._ws && this._ws.readyState === WebSocket.OPEN) {
    if (typeof message === 'object')
      message = JSON.stringify(message)
    console.log('[websocket send] ' + message)
    this._ws.send(message)
  }
}
