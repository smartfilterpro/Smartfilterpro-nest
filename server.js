console.log('Starting server...');

const express = require('express');

console.log('Express loaded');

const app = express();
const PORT = 8080;

app.get('/', function(req, res) {
  res.send('Hello World');
});

app.listen(PORT, function() {
  console.log('Server running on port 8080');
});