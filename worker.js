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
          "Access-Control-Allow-Origin": "*",
        }
      });
    }

    // --- ENDPOINT /summary ---
    if (url.pathname === "/summary") {
      const summary = await this.getSummary(env);
      return new Response(JSON.stringify(summary), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        }
      });
    }

    // 🔸 Endpoint: Upload ke Bunny.net Video Library + Simpan ke Firestore + ShrinkMe.io
    if (request.method === "POST" && url.pathname === "/upload") {
      const formData = await request.formData();
      const file = formData.get("file");

      if (!file) {
        return new Response(JSON.stringify({ error: "No file provided" }), {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          }
        });
      }

      try {
        // 1. Buat video entry terlebih dahulu di BunnyCDN (menghasilkan GUID)
        const createVideoResponse = await fetch(
          `https://video.bunnycdn.com/library/${env.BUNNY_LIBRARY_ID}/videos`,
          {
            method: "POST",
            headers: {
              "Authorization": env.BUNNY_API_KEY,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              title: file.name,
            })
          }
        );

        if (!createVideoResponse.ok) {
            const errorText = await createVideoResponse.text();
            console.error("BunnyCDN Create Video Error:", errorText);
            return new Response(JSON.stringify({ error: `Bunny create video failed: ${errorText}` }), {
              status: 500,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              }
            });
        }

        const createVideoData = await createVideoResponse.json();
        const bunnyVideoId = createVideoData.guid;

        // 2. Kirim file video ke endpoint upload spesifik GUID
        const fileBuffer = await file.arrayBuffer();

        const uploadVideoResponse = await fetch(
          `https://video.bunnycdn.com/library/${env.BUNNY_LIBRARY_ID}/videos/${bunnyVideoId}`,
          {
            method: "PUT",
            body: fileBuffer,
            headers: {
              "Authorization": env.BUNNY_API_KEY,
            }
          }
        );

        if (!uploadVideoResponse.ok) {
          const errorText = await uploadVideoResponse.text();
          console.error("BunnyCDN Upload Video Error:", errorText);
          // Hapus video entry jika upload gagal
          try {
              await fetch(`https://video.bunnycdn.com/library/${env.BUNNY_LIBRARY_ID}/videos/${bunnyVideoId}`, {
                  method: "DELETE",
                  headers: { "Authorization": env.BUNNY_API_KEY }
              });
          } catch (cleanupErr) {
              console.error("Failed to cleanup failed upload:", cleanupErr);
          }
          return new Response(JSON.stringify({ error: `Bunny video upload failed: ${errorText}` }), {
            status: 500,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            }
          });
        }

        // 3. Generate link player
        const bunnyVideoUrl = `https://iframe.mediadelivery.net/embed/${env.BUNNY_LIBRARY_ID}/${bunnyVideoId}`;

        // 4. Generate link monetisasi via ShrinkMe.io
        let shrinkMeUrl = null;
        try {
          const shrinkMeResponse = await fetch("https://shrinkme.io/api/v1/link", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.SHRINKME_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              url: bunnyVideoUrl,
            })
          });

          if (shrinkMeResponse.ok) {
            const shrinkMeData = await shrinkMeResponse.json();
            shrinkMeUrl = shrinkMeData.shortenedUrl;
          } else {
            console.error("ShrinkMe.io API error:", await shrinkMeResponse.text());
          }
        } catch (e) {
          console.error("Failed to call ShrinkMe.io API:", e);
        }

        // 5. Simpan metadata ke Firestore
        const fileData = {
          name: file.name,
          size: file.size,
          bunnyVideoId: bunnyVideoId,
          bunnyLibraryId: env.BUNNY_LIBRARY_ID,
          bunnyPlayerUrl: bunnyVideoUrl,
          shrinkMeUrl: shrinkMeUrl,
          uploadedAt: new Date().toISOString(),
        };

        await this.saveFileToFirestore(env, bunnyVideoId, fileData);

        // 6. Update summary
        await this.updateSummary(env, file.size, 1);

        const response = {
          success: true,
          originalName: file.name,
          size: file.size,
          bunnyUrl: bunnyVideoUrl,
          shrinkMeUrl: shrinkMeUrl,
          fileId: bunnyVideoId
        };

        return new Response(JSON.stringify(response), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          }
        });
      } catch (e) {
        console.error("Upload process error:", e);
        return new Response(JSON.stringify({ error: `Upload process failed: ${e.message}` }), {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          }
        });
      }
    }

    // 🔸 Endpoint: Hapus video dari Bunny.net Video Library + Firestore
    if (request.method === "POST" && url.pathname === "/delete") {
      const { fileId } = await request.json(); // fileId adalah GUID video

      if (!fileId) {
        return new Response(JSON.stringify({ error: "File ID (Video GUID) is required" }), {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          }
        });
      }

      // 1. Ambil metadata file dari Firestore (Opsional, untuk ukuran)
      const fileDocUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/files/${fileId}`;
      const fileDocResponse = await fetch(fileDocUrl, {
        headers: { "Content-Type": "application/json" }
      });

      let fileSize = 0;
      if (fileDocResponse.ok) {
        const fileDoc = await fileDocResponse.json();
        const fields = fileDoc.fields;
        fileSize = parseInt(fields.size?.integerValue || "0");
      }

      // 2. Hapus video dari Bunny.net Video Library
      const deleteBunnyResponse = await fetch(
        `https://video.bunnycdn.com/library/${env.BUNNY_LIBRARY_ID}/videos/${fileId}`,
        {
          method: "DELETE",
          headers: {
            "Authorization": env.BUNNY_API_KEY,
          }
        }
      );

      if (!deleteBunnyResponse.ok) {
        const errorText = await deleteBunnyResponse.text();
        console.error("BunnyCDN Delete failed:", errorText);
        // Jangan kembalikan error jika hanya Bunny yang gagal — kita tetap hapus dari Firestore
      }

      // 3. Hapus dokumen dari Firestore
      await fetch(fileDocUrl, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" }
      });

      // 4. Update summary (kurangi file dan ukuran)
      await this.updateSummary(env, -fileSize, -1);

      return new Response(JSON.stringify({ success: true, message: "File deleted successfully" }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        }
      });
    }

    // --- DEFAULT RESPONSE ---
    return new Response(
      "Hello from viyey-worker! Use /health, /summary, POST /upload, or POST /delete",
      {
        headers: {
          "Content-Type": "text/plain",
          "Access-Control-Allow-Origin": "*",
        }
      }
    );
  },

  async saveFileToFirestore(env, fileId, fileData) {
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/files/${fileId}`;
    const payload = {
      fields: {
        name: { stringValue: fileData.name },
        size: { integerValue: fileData.size.toString() },
        bunnyVideoId: { stringValue: fileData.bunnyVideoId },
        bunnyLibraryId: { stringValue: fileData.bunnyLibraryId },
        bunnyPlayerUrl: { stringValue: fileData.bunnyPlayerUrl },
        shrinkMeUrl: { stringValue: fileData.shrinkMeUrl || "" },
        uploadedAt: { timestampValue: fileData.uploadedAt },
      }
    };

    await fetch(firestoreUrl, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  },

  async updateSummary(env, fileSizeChange, fileCountChange) {
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

    const newTotalFiles = currentSummary.totalFiles + fileCountChange;
    const newTotalSize = currentSummary.totalSizeBytes + fileSizeChange;
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
      headers: { "Content-Type": "application/json" },
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
