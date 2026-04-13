// Vercel Serverless Function — Start Task
// Sets Task Started On = now, clears Task Done On + Duration Display, Task Status = In Progress
// If current Task Status is "Review Needed" → keeps Accumulated Mins (continuation after QC rejection)
// Otherwise → resets Accumulated Mins to 0 (fresh start)
// Chain: Task → Content Production → Content Status = In Production
//              → Deals → Campaign → Campaign Status = Active
// Environment variables: NOTION_API_KEY

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  try {
    const NOTION_KEY = process.env.NOTION_API_KEY;
    if (!NOTION_KEY) return res.status(500).json({ error: 'NOTION_API_KEY not set' });

    const headers = {
      'Authorization': `Bearer ${NOTION_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    };

    const body = req.body || {};
    const taskPageId = (
      body.page_id ||
      (body.data && body.data.id) ||
      (body.source && body.source.page_id)
    );

    if (!taskPageId) {
      return res.status(400).json({ error: 'Missing page_id in request body.' });
    }

    // Fetch current task page
    const taskRes = await fetch(`https://api.notion.com/v1/pages/${taskPageId}`, { headers });
    if (!taskRes.ok) throw new Error(`Failed to fetch task: ${await taskRes.text()}`);
    const taskPage = await taskRes.json();
    const props = taskPage.properties;

    const taskName = props['Task List']?.title?.map(t => t.plain_text).join('') || '';
    const currentStatus = props['Task Status']?.status?.name || '';
    const existingAccumulatedMins = props['Accumulated Mins']?.number || 0;
    const contentRelation = props['Content Production']?.relation || [];

    const isQcRejection = currentStatus === 'Review Needed';
    const newAccumulatedMins = isQcRejection ? existingAccumulatedMins : 0;

    const now = new Date().toISOString();

    // Step 1: Update task status
    const updateRes = await fetch(`https://api.notion.com/v1/pages/${taskPageId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        properties: {
          'Task Started On':  { date: { start: now } },
          'Task Done On':     { date: null },
          'Duration Display': { rich_text: [] },
          'Task Status':      { status: { name: 'In progress' } },
          'Accumulated Mins': { number: newAccumulatedMins },
        },
      }),
    });
    if (!updateRes.ok) throw new Error(`Failed to start task: ${await updateRes.text()}`);

    let contentStatusUpdated = false;
    let campaignStatusUpdated = false;
    let campaignId = null;

    if (contentRelation.length > 0) {
      const contentPageId = contentRelation[0].id;

      // Step 2: Set Content Production → In Production
      try {
        const contentUpdateRes = await fetch(`https://api.notion.com/v1/pages/${contentPageId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            properties: {
              'Content Status': { status: { name: 'In Production' } },
            },
          }),
        });
        if (contentUpdateRes.ok) contentStatusUpdated = true;
      } catch (e) {
        console.error('Content status update failed (non-fatal):', e.message);
      }

      // Step 3: Fetch Content Production → read Deals relation
      try {
        const contentPageRes = await fetch(`https://api.notion.com/v1/pages/${contentPageId}`, { headers });
        if (contentPageRes.ok) {
          const contentPage = await contentPageRes.json();
          const dealsRelation = contentPage.properties['Deals']?.relation || [];

          if (dealsRelation.length > 0) {
            const dealPageId = dealsRelation[0].id;

            // Step 4: Fetch Deal → read Campaign relation
            const dealPageRes = await fetch(`https://api.notion.com/v1/pages/${dealPageId}`, { headers });
            if (dealPageRes.ok) {
              const dealPage = await dealPageRes.json();
              const campaignRelation = dealPage.properties['Campaign']?.relation || [];

              if (campaignRelation.length > 0) {
                campaignId = campaignRelation[0].id;

                // Step 5: Set Campaign Status → Active
                const campaignUpdateRes = await fetch(`https://api.notion.com/v1/pages/${campaignId}`, {
                  method: 'PATCH',
                  headers,
                  body: JSON.stringify({
                    properties: {
                      'Campaign Status': { status: { name: 'Active' } },
                    },
                  }),
                });
                if (campaignUpdateRes.ok) campaignStatusUpdated = true;
              }
            }
          }
        }
      } catch (e) {
        console.error('Campaign status update failed (non-fatal):', e.message);
      }
    }

    return res.status(200).json({
      success: true,
      message: isQcRejection
        ? `"${taskName}" restarted after QC rejection. Accumulated time preserved (${Math.round(newAccumulatedMins)} mins so far).`
        : `"${taskName}" started. Timer is running.`,
      task: taskName,
      startedAt: now,
      accumulatedMins: newAccumulatedMins,
      isQcRejection,
      contentStatusUpdated,
      campaignStatusUpdated,
      campaignId,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
