const express = require(‘express’);
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

app.get(’/’, (req, res) => {
res.send(‘Server is running!’);
});

app.post(’/webhook’, (req, res) => {
console.log(‘Received webhook:’, req.body);
res.status(200).send(‘OK’);
});

app.listen(PORT, () => {
console.log(`Server running on port ${PORT}`);
});