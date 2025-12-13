import pino from 'pino';
import { CONFIG } from '../../config/config';

const logger = pino({ 
  level: CONFIG.logLevel,
  transport: {
    target: 'pino-pretty',
    options: { 
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname'
    }
  }
});

export default logger;