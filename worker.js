// Worker Entry
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, DELETE',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json'
    };

    // Route: Process upload and AI tagging
    if (request.method === 'POST') {
      try {
        const formData = await request.formData();
        const imageFile = formData.get('file');
        const thumbnailFile = formData.get('thumbnail') || imageFile; // 如果前端传了缩略图就用，没有就用原图

        if (!imageFile) return new Response(JSON.stringify({ error: "No image file provided" }), { status: 400, headers: corsHeaders });

        const fileExt = imageFile.name.split('.').pop();
        const fileName = `${crypto.randomUUID()}.${fileExt}`;
        await env.MY_BUCKET.put(fileName, imageFile.stream());

	// 【注意】这里要把 "https://你的R2域名" 换成你记事本里刚才存的 R2.dev 链接！
        const publicR2Url = `https://pub-xxxxxxxxxxxxxx.r2.dev/${fileName}`;

        // Vision Model configuration
        const aiArrayBuffer = await thumbnailFile.arrayBuffer();
        const aiUint8Array = new Uint8Array(aiArrayBuffer);

        const aiResponse = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
          image: [...aiUint8Array],
          prompt: "分析这张图片，提供5到8个描述图片的简体中文关键词，词语之间用 | 分隔。强制规则：仅返回中文关键词，禁止返回任何英文、前缀（如“关键词:”、“Tags:”）、特殊符号（如“*”）、句子或解释，只输出用逗号分隔的中文字符串。",
          max_tokens: 30,
          temperature: 0.1
        });

        // Clean up AI output
        let tags = aiResponse.response.trim();
        if (/[\u4e00-\u9fa5]/.test(tags)) {
          tags = tags.replace(/^[^\u4e00-\u9fa5]+/, '');
        } else {
          tags = tags.replace(/^.*:\s*/, '');
        }
        tags = tags.replace(/[。！.]$/, '');

        if (!tags) tags = "未识别标签";

        await env.MY_DB.prepare("INSERT INTO images (image_url, ai_tags) VALUES (?, ?)").bind(publicR2Url, tags).run();

        return new Response(JSON.stringify({ success: true, url: publicR2Url, tags: tags }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    // Route: Search and model setup
    if (request.method === 'GET') {
      const url = new URL(request.url);

      if (url.searchParams.get('setup') === 'agree') {
        try {
          await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', { prompt: "agree" });
          return new Response("Setup successful", {
            headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
          });
        } catch (e) {
          if (e.message.includes("Thank you for agreeing")) {
            return new Response("Setup completed successfully", {
              status: 200,
              headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
            });
          }
          return new Response("Setup error: " + e.message, { headers: corsHeaders });
        }
      }

      const keyword = url.searchParams.get('keyword');
      let query = "SELECT * FROM images ORDER BY upload_time DESC LIMIT 50";
      let params = [];

      if (keyword) {
        query = "SELECT * FROM images WHERE ai_tags LIKE ? ORDER BY upload_time DESC";
        params = [`%${keyword}%`];
      }

      const { results } = await env.MY_DB.prepare(query).bind(...params).all();
      return new Response(JSON.stringify(results), { headers: corsHeaders });
    }

    // Route: Process deletion
    if (request.method === 'DELETE') {
      try {
        const url = new URL(request.url);
        const imageUrl = url.searchParams.get('url');
        if (!imageUrl) return new Response(JSON.stringify({ error: "No image URL provided" }), { status: 400, headers: corsHeaders });

        const fileName = imageUrl.substring(imageUrl.lastIndexOf('/') + 1);

        await env.MY_BUCKET.delete(fileName);
        await env.MY_DB.prepare("DELETE FROM images WHERE image_url = ?").bind(imageUrl).run();

        return new Response(JSON.stringify({ success: true, message: "Deleted successfully" }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response("Service is running", { headers: corsHeaders });
  }
};