module.exports = {
  apps: [{
    name: 'clawdback',
    script: 'server.js',
    env: {
      PORT: 7788,
      NODE_ENV: 'production'
    }
  }]
}
