import { SponsorError, type ActionQuoteRequest, type EnrollmentQuoteRequest, type SignedQuote, type SponsoredActionQuote, type SponsoredActionQuoteResponse } from "./types.js";
import { SponsorQuoteService } from "./service.js";

export interface HttpRequest { method: string; path: string; body?: unknown; }
export interface HttpResponse { status: number; body: unknown; }

/** Deliberately flattened so clients can pass the bounded quote directly to the ComFi instruction. */
export function actionQuoteResponse(signed: SignedQuote<SponsoredActionQuote>): SponsoredActionQuoteResponse {
  return { ...signed.quote, signature: signed.signature };
}

/** Adapter-friendly handlers; bind these to Express, Hono, Lambda, or a Fetch server. */
export function createSponsorApi(service: SponsorQuoteService) {
  return async (request: HttpRequest): Promise<HttpResponse> => {
    try {
      if (request.method !== "POST") return { status: 405, body: { error: { code: "METHOD_NOT_ALLOWED" } } };
      if (request.path === "/v1/quotes/actions") return { status: 201, body: actionQuoteResponse(await service.issueActionQuote(request.body as ActionQuoteRequest)) };
      if (request.path === "/v1/quotes/enrollment") return { status: 201, body: await service.issueEnrollmentQuote(request.body as EnrollmentQuoteRequest) };
      return { status: 404, body: { error: { code: "NOT_FOUND" } } };
    } catch (error) {
      if (error instanceof SponsorError) return { status: error.code === "POOL_NOT_FOUND" ? 404 : 422, body: { error: { code: error.code, message: error.message } } };
      return { status: 500, body: { error: { code: "INTERNAL_ERROR" } } };
    }
  };
}
