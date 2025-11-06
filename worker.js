export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      const healthResponse = {
        status: "OK",
        worker: "viyey-worker-ndunkgo"
      };
      return new Response(JSON.stringify(healthResponse), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Summary (mock data)
    if (url.pathname === "/summary") {
      const summary = {
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
      };
      return new Response(JSON.stringify(summary), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Upload to Bunny.net
    if (request.method === "POST" && url.pathname === "/upload") {
      const formData = await request.formData();
      const file = formData.get("file");

      if (!file) {
        return new Response(JSON.stringify({ error: "No file provided" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }

      const bunnyResponse = await fetch(
        `https://storage.bunnycdn.com/storage/${env.BUNNY_CDN_STORAGE_ID}/${file.name}`,
        {
          method: "PUT",
          body: file,
          headers: {
            "AccessKey": env.BUNNY_CDN_API_KEY,
          }
        }
      );

      if (!bunnyResponse.ok) {
        const errorText = await bunnyResponse.text();
        return new Response(JSON.stringify({ error: `Bunny upload failed: ${errorText}` }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }

      const bunnyUrl = `https://${env.BUNNY_CDN_STORAGE_ID}.b-cdn.net/${file.name}`;
      const response = {
        success: true,
        originalName: file.name,
        size: file.size,
        bunnyUrl: bunnyUrl
      };

      return new Response(JSON.stringify(response), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Default response
    return new Response(
      "Hello from viyey-worker! Use /health, /summary, or POST /upload",
      { headers: { "Content-Type": "text/plain" } }
    );
  } // <-- Penutup fungsi async fetch() - kurung kurawal ini harus di sini
} // <-- Penutup export default - kurung kurawal ini harus di sini
