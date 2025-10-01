const { PubSub } = require('@google-cloud/pubsub');
const { handleDeviceEvent } = require('./runtimeTracker');

let subscription;

async function startPubSubListener() {
  const pubsub = new PubSub({
    projectId: process.env.GOOGLE_PROJECT_ID
  });
  
  const subscriptionName = process.env.GOOGLE_PUBSUB_SUBSCRIPTION;
  subscription = pubsub.subscription(subscriptionName);
  
  subscription.on('message', async (message) => {
    try {
      const data = JSON.parse(message.data.toString());
      console.log('Received Pub/Sub message:', JSON.stringify(data, null, 2));
      
      await handleDeviceEvent(data);
      message.ack();
    } catch (error) {
      console.error('Error processing Pub/Sub message:', error);
      message.nack();
    }
  });
  
  subscription.on('error', (error) => {
    console.error('Pub/Sub subscription error:', error);
  });
  
  console.log(`Listening for messages on ${subscriptionName}`);
}

function stopPubSubListener() {
  if (subscription) {
    subscription.removeAllListeners();
    subscription.close();
  }
}

module.exports = { startPubSubListener, stopPubSubListener };
