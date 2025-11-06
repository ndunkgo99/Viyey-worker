// worker.js — Fase 1: Health + Summary lengkap (mock)
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "OK", worker: "viyey-worker" }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Summary lengkap — sesuai dashboard VIYEY
    if (url.pathname === "/summary") {
      const summary = {
        onlineViewers: 0,         // akan diupdate nanti via heartbeat/frontend
        viewsToday: 5,
        viewsYesterday: 3,
        viewsThisWeek: 42,
        viewsLastWeek: 87,
        viewsThisYear: 1245,
        totalViews: 2890,
        totalVideos: 12,
        likesToday: 0,
        totalLikes: 0
      };
      return new Response(JSON.stringify(summary, null, 2), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Root
    if (url.pathname === "/") {
      return new Response(
        "VIYEY Worker API\nEndpoints: /health, /summary",
        { headers: { "Content-Type": "text/plain" } }
      );
    }

    return new Response("404 Not Found", { status: 404 });
  }
}
