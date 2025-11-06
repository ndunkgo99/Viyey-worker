export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "OK", worker: "viyey-worker-ndunkgo" }),
        { headers: { "Content-Type": "application/json" }
      );
    }

    if (url.pathname === "/summary") {
      // Sementara masih mock data
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
        { headers: { "Content-Type": "application/json" }
      );
    }

    // 🔸 Endpoint baru: Upload ke Bunny.net
    if (request.method === "POST" && url.pathname === "/upload") {
      const formData = await request.formData();
      const file = formData.get("file");

      if (!file) {
        return new Response(JSON.stringify({ error: "No file provided" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }

      // 1. Kirim file ke Bunny.net
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

    return new Response(
      "Hello from viyey-worker! Use /health, /summary, or POST /upload",
      { headers: { "Content-Type": "text/plain" } }
    );
  } // <- Kurung kurawal ini harus pas dengan async fetch()
} // <- Kurung kurawal ini harus pas dengan export default
