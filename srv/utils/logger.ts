import pino from 'pino';
import { CONFIG } from '../../config/config';

// Only use pino-pretty in development (when it's available)
const isDevelopment = process.env.NODE_ENV !== 'production';
const hasPinoPretty = isDevelopment && (() => {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
})();

const logger = pino(hasPinoPretty ? {
  level: CONFIG.logLevel,
  transport: {
    target: 'pino-pretty',
    options: { 
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname'
    }
  }
} : {
  level: CONFIG.logLevel
});

export default logger;