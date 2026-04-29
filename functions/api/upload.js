export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        },
    });
}

export async function onRequestPost(context) {
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
    };

    const clientId = context.env.IMGUR_CLIENT_ID;
    if (!clientId) {
        return new Response(JSON.stringify({ error: 'Server misconfigured' }), { status: 500, headers: corsHeaders });
    }

    let formData;
    try {
        formData = await context.request.formData();
    } catch (e) {
        return new Response(JSON.stringify({ error: 'Invalid request body' }), { status: 400, headers: corsHeaders });
    }

    const file = formData.get('file');
    if (!file) {
        return new Response(JSON.stringify({ error: 'Missing file field' }), { status: 400, headers: corsHeaders });
    }

    const arrayBuffer = await file.arrayBuffer();

    let imgurRes;
    try {
        imgurRes = await fetch('https://api.imgur.com/3/image', {
            method: 'POST',
            headers: { Authorization: 'Client-ID ' + clientId },
            body: arrayBuffer,
        });
    } catch (e) {
        return new Response(JSON.stringify({ error: 'Network error reaching Imgur' }), { status: 502, headers: corsHeaders });
    }

    if (!imgurRes.ok) {
        const errText = await imgurRes.text().catch(() => '');
        return new Response(JSON.stringify({ error: 'Imgur error: ' + imgurRes.status, detail: errText }), { status: 502, headers: corsHeaders });
    }

    const data = await imgurRes.json();
    const url = data && data.data && data.data.link;
    if (!url) {
        return new Response(JSON.stringify({ error: 'Imgur returned no URL' }), { status: 502, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ url }), { status: 200, headers: corsHeaders });
}
