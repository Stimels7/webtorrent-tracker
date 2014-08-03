module.exports = Server

var debug = require('debug')('webtorrent-tracker')
var EventEmitter = require('events').EventEmitter
var http = require('http')
var inherits = require('inherits')
var WebSocketServer = require('ws').Server

var MAX_ANNOUNCE_PEERS = 20

inherits(Server, EventEmitter)

/**
 * A BitTorrent tracker server.
 *
 * A "BitTorrent tracker" is an HTTP service which responds to GET requests from
 * BitTorrent clients. The requests include metrics from clients that help the tracker
 * keep overall statistics about the torrent. The response includes a peer list that
 * helps the client participate in the torrent.
 *
 * @param {Object}  opts            options
 * @param {Number}  opts.interval   interval in ms that clients should announce on
 * @param {Number}  opts.trustProxy Trust 'x-forwarded-for' header from reverse proxy
 * @param {boolean} opts.http       Start an http server? (default: true)
 * @param {boolean} opts.udp        Start a udp server? (default: true)
 */
function Server (opts) {
  var self = this
  if (!(self instanceof Server)) return new Server(opts)
  EventEmitter.call(self)
  opts = opts || {}

  self._intervalMs = opts.interval
    ? opts.interval / 1000
    : 10 * 60 // 10 min (in secs)

  self.torrents = {}

  self._httpServer = http.createServer()
  self._socketServer = new WebSocketServer({ server: self._httpServer })
  // self._httpServer.on('request', self._onHttpRequest.bind(self))
  self._httpServer.on('error', self._onError.bind(self))
  self._socketServer.on('error', self._onError.bind(self))

  self._socketServer.on('connection', function (socket) {
    socket.onSend = self._onSocketSend.bind(self, socket)
    socket.on('message', self._onSocketMessage.bind(self, socket))
    socket.on('error', self._onSocketError.bind(self, socket))
    socket.on('close', self._onSocketClose.bind(self, socket))
  })
}

Server.prototype._onError = function (err) {
  var self = this
  self.emit('error', err)
}

Server.prototype.listen = function (port, onlistening) {
  var self = this

  if (onlistening) self.once('listening', onlistening)

  self._httpServer.listen(port, function (err) {
    if (err) return self.emit('error', err)
    self.emit('listening', port)
  })
}

Server.prototype.close = function (cb) {
  var self = this
  self._httpServer.close(cb)
}

Server.prototype.getSwarm = function (infoHash) {
  var self = this
  var binaryInfoHash = Buffer.isBuffer(infoHash)
    ? infoHash.toString('binary')
    : new Buffer(infoHash, 'hex').toString('binary')
  return self._getSwarm(binaryInfoHash)
}

Server.prototype._getSwarm = function (binaryInfoHash) {
  var self = this
  var swarm = self.torrents[binaryInfoHash]
  if (!swarm) {
    swarm = self.torrents[binaryInfoHash] = {
      complete: 0,
      incomplete: 0,
      peers: {}
    }
  }
  return swarm
}

Server.prototype._onSocketMessage = function (socket, data) {
  var self = this

  try {
    data = JSON.parse(data)
  } catch (err) {
    return error('invalid socket message')
  }

  var warning
  var infoHash = typeof data.info_hash === 'string' && data.info_hash
  var peerId = typeof data.peer_id === 'string' && binaryToUtf8(data.peer_id)

  if (!infoHash) return error('invalid info_hash')
  if (infoHash.length !== 20) return error('invalid info_hash')
  if (!peerId) return error('invalid peer_id')
  if (peerId.length !== 20) return error('invalid peer_id')

  var swarm = self._getSwarm(infoHash)
  var peer = swarm.peers[peerId]

  var numWant = Math.min(
    Number(data.offers && data.offers.length) || 0,
    MAX_ANNOUNCE_PEERS
  )

  switch (data.event) {
    case 'started':
      if (peer) {
        warning = 'unexpected `started` event from peer that is already in swarm'
        break
      }

      if (Number(data.left) === 0) {
        swarm.complete += 1
      } else {
        swarm.incomplete += 1
      }

      swarm.peers[peerId] = {
        socket: socket,
        peerId: peerId
      }
      self.emit('start')
      break

    case 'stopped':
      if (!peer) {
        warning = 'unexpected `stopped` event from peer that is not in swarm'
        break
      }

      if (peer.complete) {
        swarm.complete -= 1
      } else {
        swarm.incomplete -= 1
      }

      swarm.peers[peerId] = null
      self.emit('stop')
      break

    case 'completed':
      if (!peer) {
        warning = 'unexpected `completed` event from peer that is not in swarm'
        break
      }
      if (peer.complete) {
        warning = 'unexpected `completed` event from peer that is already marked as completed'
        break
      }

      swarm.complete += 1
      swarm.incomplete -= 1

      peer.complete = true
      self.emit('complete')
      break

    case '': // update
    case undefined:
      if (!peer) {
        warning = 'unexpected `update` event from peer that is not in swarm'
        break
      }

      self.emit('update')
      break

    case 'answered':
      if (!peer) {
        warning = 'unexpected `answered` event from peer that is not in swarm'
        break
      }

      var toPeerId = typeof data.to_peer_id === 'string' && data.to_peer_id
      if (!toPeerId) return error('invalid `to_peer_id`')
      var toPeer = swarm.peers[toPeerId]
      if (!toPeer) return self.emit('warning', new Error('no peer with that `to_peer_id`'))
      var answer = typeof data.answer === 'string' && data.answer

      toPeer.socket.send(answer)

      self.emit('answer')
      return // early return

    default:
      return error('invalid event') // early return
  }

  var response = {
    complete: swarm.complete,
    incomplete: swarm.incomplete,
    interval: self._intervalMs
  }

  if (warning)
    response['warning message'] = warning
  socket.send(JSON.stringify(response), socket.onSend)
  debug('sent response %s', JSON.stringify(response))

  var peers = self._getPeers(swarm, numWant)
  peers.forEach(function (peer, i) {
    peer.socket.send({
      offer: data.offers[i],
      from_peer_id: peerId
    })
  })

  function error (message) {
    debug('sent error %s', message)
    socket.send(JSON.stringify({ 'failure reason': message }), socket.onSend)
    // even though it's an error for the client, it's just a warning for the server.
    // don't crash the server because a client sent bad data :)
    self.emit('warning', new Error(message))
  }
}

// TODO: randomize the peers that are given out
Server.prototype._getPeers = function (swarm, numWant) {
  var peers = []
  for (var peerId in swarm.peers) {
    if (peers.length >= numWant) break
    var peer = swarm.peers[peerId]
    if (!peer) continue // ignore null values
    peers.push(peer)
  }
  return peers
}

Server.prototype._onSocketSend = function (socket, err) {
  var self = this
  if (err) {
    debug('Socket error %s', err.message)
    self.handleClose(socket)
  }
}

Server.prototype._onSocketClose = function (socket) {
  var self = this

  // var sockets = self.online[url]

  // if (sockets) {
  //   var index = sockets.indexOf(socket)
  //   sockets.splice(index, 1)
  //   self.sendUpdates(url)
  // }
}

function binaryToUtf8 (str) {
  return new Buffer(str, 'binary').toString('utf8')
}
