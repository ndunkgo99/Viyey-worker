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

    // 🔸 Endpoint: Upload ke Bunny.net Video Library + Simpan ke Firestore + ShrinkMe.io
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

      // 1. Kirim file ke Bunny.net Video Library (Gunakan endpoint dan header yang benar)
      const bunnyUploadResponse = await fetch(
        `https://video.bunnycdn.com/library/${env.BUNNY_LIBRARY_ID}/videos`, // Gunakan Video Library endpoint
        {
          method: "POST",
          body: file, // Kirim file langsung
          headers: {
            "Authorization": env.BUNNY_API_KEY, // Gunakan header Authorization
            // Tidak perlu menambahkan Content-Type, biarkan browser set otomatis dengan boundary
          }
        }
      );

      if (!bunnyUploadResponse.ok) {
        const errorText = await bunnyUploadResponse.text();
        console.error("BunnyCDN Upload Error:", errorText); // Log untuk debugging
        return new Response(JSON.stringify({ error: `Bunny upload failed: ${errorText}` }), {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          }
        });
      }

      // Parse respons dari BunnyCDN untuk mendapatkan Video ID
      const bunnyUploadData = await bunnyUploadResponse.json();
      const bunnyVideoId = bunnyUploadData.guid; // Gunakan GUID dari respons
      const bunnyVideoUrl = `https://iframe.mediadelivery.net/embed/${env.BUNNY_LIBRARY_ID}/${bunnyVideoId}`; // URL Player

      // 2. Generate link monetisasi via ShrinkMe.io (gunakan URL Player sebagai target)
      let shrinkMeUrl = null;
      try {
        const shrinkMeResponse = await fetch("https://shrinkme.io/api/v1/link", { // Hapus spasi di URL
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.SHRINKME_API_KEY}`, // Gunakan Bearer token
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            url: bunnyVideoUrl, // Gunakan URL player untuk monetisasi
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

      // 3. Simpan metadata ke Firestore (Gunakan GUID dari Bunny)
      const fileId = bunnyVideoId; // Gunakan GUID dari Bunny sebagai ID file
      const fileData = {
        name: file.name,
        size: file.size,
        bunnyVideoId: bunnyVideoId, // Simpan Video ID
        bunnyLibraryId: env.BUNNY_LIBRARY_ID, // Simpan Library ID
        bunnyPlayerUrl: bunnyVideoUrl, // Simpan URL player
        shrinkMeUrl: shrinkMeUrl, // Simpan URL ShrinkMe
        uploadedAt: new Date().toISOString(),
      };

      await this.saveFileToFirestore(env, fileId, fileData);

      // 4. Update summary
      await this.updateSummary(env, file.size, 1);

      const response = {
        success: true,
        originalName: file.name,
        size: file.size,
        bunnyUrl: bunnyVideoUrl, // Kembalikan URL player
        shrinkMeUrl: shrinkMeUrl,
        fileId: fileId // Kembalikan GUID sebagai fileId
      };

      return new Response(JSON.stringify(response), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        }
      });
    }

    // 🔸 Endpoint baru: Hapus video dari Bunny.net Video Library + Firestore
    if (request.method === "POST" && url.pathname === "/delete") {
      const { fileId } = await request.json(); // fileId sekarang adalah GUID video

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
      } // Jika tidak ditemukan, asumsi ukuran 0

      // 2. Hapus video dari Bunny.net Video Library
      const deleteBunnyResponse = await fetch(
        `https://video.bunnycdn.com/library/${env.BUNNY_LIBRARY_ID}/videos/${fileId}`, // Gunakan Video Library endpoint delete
        {
          method: "DELETE",
          headers: {
            "Authorization": env.BUNNY_API_KEY, // Gunakan header Authorization
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
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*", // Tambahkan header CORS ke request internal
      },
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
