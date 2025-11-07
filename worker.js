export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      const healthResponse = {
        status: "OK",
        worker: "viyey-worker-ndunkgo"
      };
      return new Response(JSON.stringify(healthResponse), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname === "/summary") {
      const summary = await this.getSummary(env);
      return new Response(JSON.stringify(summary), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // 🔸 Endpoint baru: Upload ke Bunny.net + Simpan ke Firestore + ShrinkMe.io
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

      // 2. Generate link monetisasi via ShrinkMe.io
      let shrinkMeUrl = null;
      try {
        const shrinkMeResponse = await fetch("https://shrinkme.io/api/v1/link", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.SHRINKME_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            url: bunnyUrl,
            // Tambahkan parameter lain jika diperlukan oleh ShrinkMe.io
            // misalnya: "monetize": true, "title": file.name, dll
          })
        });

        if (shrinkMeResponse.ok) {
          const shrinkMeData = await shrinkMeResponse.json();
          shrinkMeUrl = shrinkMeData.shortenedUrl; // atau nama field yang benar dari API
        } else {
          console.error("ShrinkMe.io API error:", await shrinkMeResponse.text());
        }
      } catch (e) {
        console.error("Failed to call ShrinkMe.io API:", e);
      }

      // 3. Simpan metadata ke Firestore
      const fileId = Date.now().toString();
      const fileData = {
        name: file.name,
        size: file.size,
        bunnyUrl: bunnyUrl,
        shrinkMeUrl: shrinkMeUrl, // Simpan link ShrinkMe.io
        uploadedAt: new Date().toISOString(),
      };

      await this.saveFileToFirestore(env, fileId, fileData);

      // 4. Update summary
      await this.updateSummary(env, file.size, 1); // tambah 1 file, ukuran file.size

      const response = {
        success: true,
        originalName: file.name,
        size: file.size,
        bunnyUrl: bunnyUrl,
        shrinkMeUrl: shrinkMeUrl, // Kembalikan link ShrinkMe.io ke frontend
        fileId: fileId
      };

      return new Response(JSON.stringify(response), {
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(
      "Hello from viyey-worker! Use /health, /summary, or POST /upload",
      { headers: { "Content-Type": "text/plain" } }
    );
  },

  async saveFileToFirestore(env, fileId, fileData) {
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/files/${fileId}`;
    const payload = {
      fields: {
        name: { stringValue: fileData.name },
        size: { integerValue: fileData.size.toString() },
        bunnyUrl: { stringValue: fileData.bunnyUrl },
        shrinkMeUrl: { stringValue: fileData.shrinkMeUrl || "" }, // Simpan link ShrinkMe.io
        uploadedAt: { timestampValue: fileData.uploadedAt },
      }
    };

    await fetch(firestoreUrl, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload)
    });
  },

  async updateSummary(env, fileSize, fileCount) {
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/meta/summary`;
    
    const currentSummaryResponse = await fetch(firestoreUrl, {
      headers: { "Content-Type": "application/json" }
    });
    let currentSummary = { totalFiles: 0, totalSizeBytes: 0 };
    if (currentSummaryResponse.ok) {
      const data = await currentSummaryResponse.json();
      if (data.fields) {
        currentSummary.totalFiles = parseInt(data.fields.totalFiles?.integerValue || "0");
        currentSummary.totalSizeBytes = parseInt(data.fields.totalSizeBytes?.integerValue || "0");
      }
    }

    const newTotalFiles = currentSummary.totalFiles + fileCount;
    const newTotalSize = currentSummary.totalSizeBytes + fileSize;

    const payload = {
      fields: {
        totalFiles: { integerValue: newTotalFiles.toString() },
        totalSizeBytes: { integerValue: newTotalSize.toString() },
        lastUpdated: { timestampValue: new Date().toISOString() },
      }
    };

    await fetch(firestoreUrl, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload)
    });
  },

  async getSummary(env) {
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/meta/summary`;
    const response = await fetch(firestoreUrl, {
      headers: { "Content-Type": "application/json" }
    });

    if (response.ok) {
      const data = await response.json();
      if (data.fields) {
        return {
          totalFiles: parseInt(data.fields.totalFiles?.integerValue || "0"),
          totalSizeBytes: parseInt(data.fields.totalSizeBytes?.integerValue || "0"),
          lastUpdated: data.fields.lastUpdated?.timestampValue || "N/A",
        };
      }
    }
    return { totalFiles: 0, totalSizeBytes: 0, lastUpdated: "N/A" };
  }
}
