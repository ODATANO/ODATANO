import pino from 'pino';
import { CONFIG } from '../../config/config';

/**
 * Configure Pino logger 
 */
const isDevelopment = process.env.NODE_ENV !== 'production';
const hasPinoPretty = isDevelopment && (() => {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
})();

/**
 * Create Pino logger instance 
 */
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
  // use log level from config
  level: CONFIG.logLevel
});

/**
 * Export the logger instance
 */
export default logger;