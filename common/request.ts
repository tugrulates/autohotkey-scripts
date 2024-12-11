/**
 * JSON request helpers.
 */

import { retry, type RetryOptions } from "jsr:@std/async";

/**
 * Represents an error that occurs during a request.
 */
export class RequestError extends Error {
  /**
   * Creates an instance of RequestError.
   *
   * @param msg The error message to be associated with this error.
   */
  constructor(msg: string) {
    super(msg);
    this.name = "RequestError";
  }
}

/**
 * A client for making JSON-based HTTP requests.
 */
export class JsonClient {
  /**
   * Creates an instance of the JsonClient with the specified URL and options.
   *
   * @param url The base URL to which the requests are made.
   * @param options Parameters for the requests.
   * @param options.token Optional token for authentication.
   */
  constructor(private url: string, private options: { token?: string }) {}

  /**
   * Sends a GET request to the specified path.
   *
   * @template T The expected response type.
   * @param path The path to which the GET request is made.
   * @returns A promise that resolves to the response data.
   */
  async get<T>(path: string): Promise<T> {
    const { response } = await request<T>(`${this.url}${path}`, {
      token: this.options.token,
      headers: {
        "Accept": "application/json; charset=UTF-8",
      },
    });
    return await response.json();
  }

  /**
   * Sends a POST request to the specified path with the provided body.
   *
   * @template T The expected response type.
   * @param path The path to which the POST request is made.
   * @param body The body of the POST request.
   * @returns A promise that resolves to the response data.
   */
  async post<T>(path: string, body: object): Promise<T> {
    const { response } = await request<T>(`${this.url}${path}`, {
      method: "POST",
      headers: {
        "Accept": "application/json; charset=UTF-8",
        "Content-Type": "application/json; charset=UTF-8",
      },
      body,
      token: this.options.token,
    });
    return await response.json();
  }

  /**
   * Sends a DELETE request to the specified path.
   *
   * @template T The expected response type.
   * @param path The path to which the DELETE request is made.
   * @returns A promise that resolves to the response data.
   */
  async delete<T>(path: string): Promise<T> {
    const { response } = await request<T>(`${this.url}${path}`, {
      method: "DELETE",
      headers: {
        "Accept": "application/json; charset=UTF-8",
      },
      token: this.options.token,
    });
    return await response.json();
  }
}

const TOO_MANY_REQUESTS = 429;

type RequestMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
interface RequestOptions {
  allowedErrors?: string[];
  body?: string | object;
  method?: RequestMethod;
  headers?: Record<string, string>;
  retry?: RetryOptions;
  token?: string;
  userAgent?: string;
}

/**
 * Makes an HTTP request with the given URL and options, and returns a response object.
 * Retries the request if it fails due to too many requests.
 *
 * @template T The expected response type.
 * @param url The URL to request.
 * @param options The options for the request.
 * @returns A promise that resolves to an object containing the response and optionally an error.
 * @throws {RequestError} If the response is not ok and the error type is not allowed.
 */
async function request<T>(
  url: string,
  options: RequestOptions = {},
): Promise<{
  response: Response;
  error?: { type: string; message: string };
}> {
  const response = await retry(async () => {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        ...options.headers,
        ...(options.token
          ? { "Authorization": `Bearer ${options.token}` }
          : {}),
        "User-Agent": options.userAgent ??
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1.1 Safari/605.1.15",
      },
      body: options.body
        ? (typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body))
        : undefined,
    });
    if (response.status === TOO_MANY_REQUESTS) {
      await response.body?.cancel();
      throw new Error("Too many requests");
    }
    return response;
  }, options.retry);

  if (!response.ok) {
    const error = await getErrorFromResponse(response);
    if (options.allowedErrors?.includes(error.type)) {
      return { response, error };
    }
    throw new RequestError(`${error.message} [${error.type}]`);
  }

  return { response };
}

async function getErrorFromResponse(
  response: Response,
): Promise<{ type: string; message: string }> {
  const text = await response.text();
  try {
    const { error } = JSON.parse(text) as {
      error: { type: string; message: string };
    };
    return error;
  } catch {
    return {
      type: response.status.toString(),
      message: response.statusText,
    };
  }
}
