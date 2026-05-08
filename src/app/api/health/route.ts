// GET /api/health
//
// The iOS app pings this on launch to verify the configured backend URL is
// reachable. Stays cheap on purpose — does not hit the database, so a
// dead Postgres doesn't make the health check flap.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ ok: true, timestamp: new Date().toISOString() });
}
