export default {
  async fetch(request, env, ctx) {
    // --- HANDLING CORS ---
    // Tangani preflight request (OPTIONS)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    const url = new URL(request.url);

    // --- ENDPOINT /health ---
    if (url.pathname === "/health") {
      const healthResponse = {
        status: "OK",
        worker: "viyey-worker-ndunkgo"
      };
      return new Response(JSON.stringify(healthResponse), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*", // Tambahkan header CORS
        }
      });
    }

    // --- ENDPOINT /summary ---
    if (url.pathname === "/summary") {
      const summary = await this.getSummary(env);
      return new Response(JSON.stringify(summary), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*", // Tambahkan header CORS
        }
      });
    }

    // 🔸 Endpoint: Upload ke Bunny.net + Simpan ke Firestore + ShrinkMe.io
    if (request.method === "POST" && url.pathname === "/upload") {
      const formData = await request.formData();
      const file = formData.get("file");

      if (!file) {
        return new Response(JSON.stringify({ error: "No file provided" }), {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*", // Tambahkan header CORS
          }
        });
      }

      // 1. Kirim file ke Bunny.net
      const bunnyResponse = await fetch(
        `https://storage.bunnycdn.com/storage/${env.BUNNY_CDN_STORAGE_ID}/${file.name}`, // Hapus spasi
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
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*", // Tambahkan header CORS
          }
        });
      }

      const bunnyUrl = `https://${env.BUNNY_CDN_STORAGE_ID}.b-cdn.net/${file.name}`;

      // 2. Generate link monetisasi via ShrinkMe.io
      let shrinkMeUrl = null;
      try {
        const shrinkMeResponse = await fetch("https://shrinkme.io/api/v1/link", { // Hapus spasi
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.SHRINKME_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            url: bunnyUrl,
          })
        });

        if (shrinkMeResponse.ok) {
          const shrinkMeData = await shrinkMeResponse.json();
          shrinkMeUrl = shrinkMeData.shortenedUrl; // Sesuaikan field jika berbeda
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
        shrinkMeUrl: shrinkMeUrl,
        uploadedAt: new Date().toISOString(),
      };

      await this.saveFileToFirestore(env, fileId, fileData);

      // 4. Update summary
      await this.updateSummary(env, file.size, 1);

      const response = {
        success: true,
        originalName: file.name,
        size: file.size,
        bunnyUrl: bunnyUrl,
        shrinkMeUrl: shrinkMeUrl,
        fileId: fileId
      };

      return new Response(JSON.stringify(response), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*", // Tambahkan header CORS
        }
      });
    }

    // 🔸 Endpoint baru: Hapus file dari Bunny.net + Firestore
    if (request.method === "POST" && url.pathname === "/delete") {
      const { fileId } = await request.json();

      if (!fileId) {
        return new Response(JSON.stringify({ error: "File ID is required" }), {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*", // Tambahkan header CORS
          }
        });
      }

      // 1. Ambil metadata file dari Firestore
      const fileDocUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/files/${fileId}`; // Hapus spasi
      const fileDocResponse = await fetch(fileDocUrl, {
        headers: { "Content-Type": "application/json" }
      });

      if (!fileDocResponse.ok) {
        return new Response(JSON.stringify({ error: "File not found in Firestore" }), {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*", // Tambahkan header CORS
          }
        });
      }

      const fileDoc = await fileDocResponse.json();
      const fields = fileDoc.fields;
      const bunnyUrl = fields.bunnyUrl?.stringValue;
      const fileSize = parseInt(fields.size?.integerValue || "0");

      if (!bunnyUrl) {
        return new Response(JSON.stringify({ error: "Bunny URL not found for this file" }), {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*", // Tambahkan header CORS
          }
        });
      }

      // 2. Hapus file dari Bunny.net
      const fileName = bunnyUrl.split('/').pop(); // Ambil nama file dari URL
      const deleteBunnyResponse = await fetch(
        `https://storage.bunnycdn.com/storage/${env.BUNNY_CDN_STORAGE_ID}/${fileName}`, // Hapus spasi
        {
          method: "DELETE",
          headers: {
            "AccessKey": env.BUNNY_CDN_API_KEY,
          }
        }
      );

      if (!deleteBunnyResponse.ok) {
        const errorText = await deleteBunnyResponse.text();
        console.error("Bunny delete failed:", errorText);
        // Jangan kembalikan error jika hanya Bunny yang gagal — kita tetap hapus dari Firestore
      }

      // 3. Hapus dokumen dari Firestore
      await fetch(fileDocUrl, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" }
      });

      // 4. Update summary (kurangi file dan ukuran)
      await this.updateSummary(env, -fileSize, -1); // kurangi 1 file, kurangi ukuran file

      return new Response(JSON.stringify({ success: true, message: "File deleted successfully" }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*", // Tambahkan header CORS
        }
      });
    }

    // --- DEFAULT RESPONSE ---
    return new Response(
      "Hello from viyey-worker! Use /health, /summary, POST /upload, or POST /delete",
      {
        headers: {
          "Content-Type": "text/plain",
          "Access-Control-Allow-Origin": "*", // Tambahkan header CORS
        }
      }
    );
  },

  async saveFileToFirestore(env, fileId, fileData) {
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/files/${fileId}`; // Hapus spasi
    const payload = {
      fields: {
        name: { stringValue: fileData.name },
        size: { integerValue: fileData.size.toString() },
        bunnyUrl: { stringValue: fileData.bunnyUrl },
        shrinkMeUrl: { stringValue: fileData.shrinkMeUrl || "" },
        uploadedAt: { timestampValue: fileData.uploadedAt },
      }
    };

    await fetch(firestoreUrl, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*", // Tambahkan header CORS ke request internal
      },
      body: JSON.stringify(payload)
    });
  },

  async updateSummary(env, fileSizeChange, fileCountChange) {
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/meta/summary`; // Hapus spasi
    
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

    // Update data
    const newTotalFiles = currentSummary.totalFiles + fileCountChange;
    const newTotalSize = currentSummary.totalSizeBytes + fileSizeChange;

    // Pastikan tidak negatif
    const finalTotalFiles = Math.max(0, newTotalFiles);
    const finalTotalSize = Math.max(0, newTotalSize);

    const payload = {
      fields: {
        totalFiles: { integerValue: finalTotalFiles.toString() },
        totalSizeBytes: { integerValue: finalTotalSize.toString() },
        lastUpdated: { timestampValue: new Date().toISOString() },
      }
    };

    await fetch(firestoreUrl, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*", // Tambahkan header CORS ke request internal
      },
      body: JSON.stringify(payload)
    });
  },

  async getSummary(env) {
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/meta/summary`; // Hapus spasi
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
