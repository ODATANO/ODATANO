import pino from 'pino';

const level = process.env.LOG_LEVEL || 'info';

const logger = pino({ level });

export default logger;
