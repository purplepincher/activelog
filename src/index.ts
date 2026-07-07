export default {
  async fetch(request: Request, env: any): Promise<Response> {
    try {
      const response = await env.ASSETS.fetch(request);
      if (!response) {
        return new Response("Not found", { status: 404 });
      }
      return response;
    } catch (e) {
      return new Response(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`, { status: 500 });
    }
  },
};
