// Root landing page. There's no UI for this backend — point visitors at
// the health check so they at least get something useful when they
// land on the bare domain.

export default function Page() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>KochHeute API</h1>
      <p>
        This is the KochHeute backend. There is no web UI here. Try{" "}
        <code>/api/health</code>.
      </p>
    </main>
  );
}
