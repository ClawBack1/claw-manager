module.exports = {
  apps: [{
    name: 'claw-manager',
    script: 'server.js',
    env: {
      PORT: 7788,
      NODE_ENV: 'production'
    }
  }]
}
