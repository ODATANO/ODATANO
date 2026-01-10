import pino from 'pino';
import { CONFIG } from '../../config/config';
/**
 * Create Pino logger instance 
 */
const logger = pino({
  level: CONFIG.logLevel,
  transport: {
    target: 'pino-pretty',
    options: { 
      colorize: true,
      translateTime: 'HH:mm:ss',
      ignore: 'pid,hostname'
    }
  }
});

/**
 * Export the logger instance
 */
export default logger;