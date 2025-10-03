const express = require('express');
const { getPool } = require('../database/db');

const router = express.Router();

// Endpoint for Bubble to send OAuth tokens
router.post('/store-tokens', async (req, res) => {
  const { userId, accessToken, refreshToken, expiresIn, projectId, apiKey } = req.body;
  
  // Verify API key
  if (apiKey !== process.env.RAILWAY_API_KEY) {
    console.error('Invalid API key provided');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  // Validate required fields
  if (!userId || !accessToken || !refreshToken) {
    return res.status(400).json({ 
      error: 'Missing required fields',
      required: ['userId', 'accessToken', 'refreshToken']
    });
  }
  
  try {
    const expiresAt = new Date(Date.now() + (expiresIn || 3600) * 1000);
    
    const pool = getPool();
    await pool.query(`
      INSERT INTO oauth_tokens (user_id, access_token, refresh_token, expires_at, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        access_token = EXCLUDED.access_token,
        refresh_token = EXCLUDED.refresh_token,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW()
    `, [userId, accessToken, refreshToken, expiresAt]);
    
    console.log(`Tokens stored successfully for user: ${userId}`);
    
    res.json({ 
      success: true, 
      message: 'Tokens stored successfully',
      userId: userId
    });
  } catch (error) {
    console.error('Error storing tokens:', error);
    res.status(500).json({ error: 'Failed to store tokens' });
  }
});

// Endpoint to check if tokens exist for a user
router.get('/check-tokens/:userId', async (req, res) => {
  const { userId } = req.params;
  const { apiKey } = req.query;
  
  if (apiKey !== process.env.RAILWAY_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  try {
    const pool = getPool();
    const result = await pool.query(
      'SELECT user_id, expires_at FROM oauth_tokens WHERE user_id = $1',
      [userId]
    );
    
    if (result.rows.length === 0) {
      return res.json({ exists: false });
    }
    
    const expiresAt = new Date(result.rows[0].expires_at);
    const isExpired = expiresAt < new Date();
    
    res.json({ 
      exists: true,
      expired: isExpired,
      expiresAt: expiresAt.toISOString()
    });
  } catch (error) {
    console.error('Error checking tokens:', error);
    res.status(500).json({ error: 'Failed to check tokens' });
  }
});

module.exports = router;