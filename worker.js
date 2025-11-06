export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "OK", worker: "viyey-worker" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.pathname === "/summary") {
      return new Response(
        JSON.stringify({
          onlineViewers: 0,
          viewsToday: 5,
          viewsYesterday: 3,
          viewsThisWeek: 42,
          viewsLastWeek: 87,
          viewsThisYear: 1245,
          totalViews: 2890,
          totalVideos: 12,
          likesToday: 0,
          totalLikes: 0
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      "Hello from viyey-worker! Use /health or /summary",
      { headers: { "Content-Type": "text/plain" } }
    );
  }
}
