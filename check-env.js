const { env } = require('./src/config/env');

console.log('CLAUDE_API_KEY loaded:', !!env.CLAUDE_API_KEY);
console.log('CLAUDE_API_KEY starts with:', env.CLAUDE_API_KEY?.substring(0, 10) + '...');
console.log('CLAUDE_API_KEY length:', env.CLAUDE_API_KEY?.length);
console.log('CLAUDE_MODEL:', env.CLAUDE_MODEL);
console.log('All env keys:', Object.keys(env));
