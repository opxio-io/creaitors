// Vercel Serverless Function — Campaign Stats
// Queries Monthly Campaigns DB for active campaign metrics
// Environment variables: NOTION_API_KEY

const CAMPAIGNS_DB_ID = '3188b289e31a806bac9de1ee09aff2ad';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  try {
    const NOTION_KEY = process.env.NOTION_API_KEY;
    if (!NOTION_KEY) return res.status(500).json({ error: 'NOTION_API_KEY not set' });

    const headers = {
      'Authorization': `Bearer ${NOTION_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    };

    // Paginated query helper
    async function queryAll(dbId, filter) {
      let all = [], hasMore = true, cursor;
      while (hasMore) {
        const body = { page_size: 100 };
        if (filter) body.filter = filter;
        if (cursor) body.start_cursor = cursor;
        const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
          method: 'POST', headers, body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`DB query error (${r.status}): ${await r.text()}`);
        const d = await r.json();
        all = all.concat(d.results);
        hasMore = d.has_more;
        cursor = d.next_cursor;
      }
      return all;
    }

    // Property helpers
    const getTitle  = p => p?.type === 'title' ? (p.title || []).map(t => t.plain_text).join('') : '';
    const getStatus = p => p?.type === 'status' ? p.status?.name : null;
    const getNumber = p => p?.type === 'number' ? (p.number || 0) : 0;
    const getSelect = p => p?.type === 'select' ? p.select?.name : null;
    const getFormula = p => {
      if (!p || p.type !== 'formula') return 0;
      const f = p.formula;
      if (f.type === 'number') return f.number || 0;
      if (f.type === 'string') return parseFloat(f.string) || 0;
      return 0;
    };
    const getRollupNumber = p => {
      if (!p || p.type !== 'rollup') return 0;
      const r = p.rollup;
      if (r.type === 'number') return r.number || 0;
      if (r.type === 'array') {
        return (r.array || []).reduce((sum, item) => {
          if (item.type === 'number') return sum + (item.number || 0);
          return sum;
        }, 0);
      }
      return 0;
    };

    // Query all campaigns
    const campaigns = await queryAll(CAMPAIGNS_DB_ID);

    let activeCampaigns = 0;
    let totalDeliverables = 0;
    let completedDeliverables = 0;
    let totalBudget = 0;
    let totalAdsBudget = 0;
    let totalKolBudget = 0;
    let totalGmv = 0;
    let retainerReceived = 0;
    let retainerTotal = 0;
    let kolBudgetReceived = 0;
    let kolBudgetTotal = 0;
    const typeCounts = {};
    const completionRates = [];

    for (const page of campaigns) {
      const props = page.properties;
      const status = getStatus(props['Campaign Status']);
      const type = getSelect(props['Campaign Type']);

      // Only count active campaigns
      if (status !== 'Active') continue;

      activeCampaigns++;

      // Count by type
      if (type) {
        typeCounts[type] = (typeCounts[type] || 0) + 1;
      }

      // Deliverables — planned
      const videos    = getNumber(props['Videos']);
      const posters   = getNumber(props['Posters']);
      const live      = getNumber(props['Live Session']);
      const kolPosts  = getNumber(props['KOL Posts']);
      const planned   = videos + posters + live + kolPosts;

      // Deliverables — completed (rollups)
      const videosDone  = getRollupNumber(props['Videos Completed']);
      const postersDone = getRollupNumber(props['Posters Completed']);
      const liveDone    = getRollupNumber(props['Livestreams Completed']);
      const kolDone     = getRollupNumber(props['KOL Postings Completed']);
      const done        = videosDone + postersDone + liveDone + kolDone;

      totalDeliverables += planned;
      completedDeliverables += done;

      if (planned > 0) {
        completionRates.push(Math.round((done / planned) * 100));
      }

      // Budget fields (if they exist on campaign — read from formula/number props)
      totalAdsBudget  += getNumber(props['Ads Budget']) || getFormula(props['Ads Budget']);
      totalKolBudget  += getNumber(props['KOL Budget']) || getFormula(props['KOL Budget']);
      totalGmv        += getNumber(props['GMV']) || getFormula(props['GMV']);
    }

    totalBudget = totalAdsBudget + totalKolBudget;

    const avgCompletion = completionRates.length > 0
      ? Math.round(completionRates.reduce((a, b) => a + b, 0) / completionRates.length)
      : 0;

    const typeBreakdown = Object.entries(typeCounts).map(([name, count]) => ({ name, count }));

    return res.status(200).json({
      activeCampaigns,
      totalBudget,
      totalAdsBudget,
      totalKolBudget,
      totalDeliverables,
      completedDeliverables,
      avgCompletion,
      totalGmv,
      retainerReceived,
      retainerTotal,
      kolBudgetReceived,
      kolBudgetTotal,
      typeBreakdown,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
