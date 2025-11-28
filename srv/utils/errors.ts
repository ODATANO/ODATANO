export interface ProviderErrorResult {
  status: number;
  message: string;
}

export interface HttpErrorLike {
  message?: string;
  code?: string;
  response?: {
    status?: number;
    data?: {
      error?: string;
      message?: string;
      [k: string]: any;
    };
  };
  [k: string]: any;
}

export function mapProviderError(err: HttpErrorLike | unknown): ProviderErrorResult {
  let status = 500;
  let message = "Unknown error";
  
  const e = (err ?? {}) as HttpErrorLike;

  // Base error message
  if (e.message) {
    message = e.message;
  } else {
    message = String(err);
  }

  // ---------------------------------------------------
  // HTTP Response Handling
  // ---------------------------------------------------
  if (e.response?.status) {
    status = e.response.status;

    const data = e.response.data ?? {};

    // extract helpful message if present in provider response
    if (data.error || data.message) {
      message = data.error || data.message!;
    } else {
      message = `Provider returned HTTP ${status}`;
    }
  }

  // ---------------------------------------------------
  // Network / Timeout Errors
  // ---------------------------------------------------
  const msg = message.toLowerCase();
  if (
    e.code === "ECONNABORTED" ||
    msg.includes("timed out") ||
    msg.includes("timeout")
  ) {
    status = 503;
    message = "Provider timeout or unreachable";
  }

  // ---------------------------------------------------
  // Custom Provider NOT_FOUND Convention
  // ---------------------------------------------------
  if (message === "NOT_FOUND" || message === "not_found") {
    status = 404;
    message = "Not found";
  }

  // ---------------------------------------------------
  // Unauthorized
  // ---------------------------------------------------
  if (status === 401 || /unauthor/i.test(message)) {
    status = 401;
    message = "Unauthorized access to provider";
  }

  return { status, message };
}

export default mapProviderError;
