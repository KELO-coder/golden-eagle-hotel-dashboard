import { readFile, writeFile } from 'node:fs/promises';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error('OPENAI_API_KEY is not configured.');

const config = JSON.parse(await readFile('config/market-intelligence.json', 'utf8'));
const today = new Date().toISOString().slice(0, 10);
const startDate = new Date(Date.now() - config.lookbackDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

function stripCodeFence(value) {
  return value.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
}

function asItems(value, city) {
  const items = Array.isArray(value?.items) ? value.items : [];
  return items.filter((item) => item && ['city', 'competitor'].includes(item.type) && item.title && item.summary && item.sourceUrl)
    .map((item) => ({
      type: item.type,
      city,
      hotels: Array.isArray(item.hotels) ? item.hotels.slice(0, 4) : [],
      title: String(item.title).slice(0, 90),
      summary: String(item.summary).slice(0, 240),
      impact: String(item.impact || '待评估').slice(0, 50),
      date: /^\d{4}-\d{2}-\d{2}$/.test(item.date || '') ? item.date : today,
      sourceTitle: String(item.sourceTitle || '来源').slice(0, 90),
      sourceUrl: String(item.sourceUrl)
    }));
}

async function collectCity({ name: city, hotels }) {
  const prompt = `你是中国酒店市场情报分析师。请使用网络搜索，检索 ${city} 在 ${startDate} 至 ${today} 期间、与以下酒店相关的市场讯息：${hotels.join('、')}。

重点寻找两类可核验事实：
1. city：城市事件，包括会展、演出、赛事、交通、政策、商圈活动，以及可能影响酒店需求的公开事件。
2. competitor：这些酒店周边或同城中高端竞业酒店的开业、焕新、促销、品牌营销、价格策略或评价变化。

只保留有明确公开来源链接且发生日期在此窗口内的讯息。不要编造、不要重复、不要把推测写成事实。每条 summary 用中文说明“发生了什么 + 可能的酒店经营影响”。每类最多 ${config.maxItemsPerCity} 条。

只输出如下 JSON，不要 Markdown：
{"items":[{"type":"city 或 competitor","hotels":["相关酒店"],"title":"标题","summary":"摘要","impact":"高/中/低","date":"YYYY-MM-DD","sourceTitle":"来源名称","sourceUrl":"https://..."}]}`;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5-mini',
      tools: [{ type: 'web_search' }],
      input: prompt
    })
  });
  if (!response.ok) throw new Error(`OpenAI request failed for ${city}: ${response.status} ${await response.text()}`);
  const payload = await response.json();
  const output = payload.output_text || payload.output?.flatMap((entry) => entry.content || []).map((part) => part.text || part.value || '').join('') || '';
  if (!output.trim()) throw new Error(`Empty AI response for ${city}.`);
  try {
    return asItems(JSON.parse(stripCodeFence(output)), city);
  } catch (error) {
    throw new Error(`Invalid AI response for ${city}: ${error.message}; preview=${output.slice(0, 300)}`);
  }
}

const results = await Promise.allSettled(config.cities.map(collectCity));
const items = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
const failedCities = results.flatMap((result, index) => result.status === 'rejected' ? [{ city: config.cities[index].name, error: result.reason.message }] : []);

for (const failed of failedCities) console.warn(`Collection failed for ${failed.city}: ${failed.error}`);

await writeFile('data/market-intelligence.json', `${JSON.stringify({
  generatedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
  generatedDate: today,
  lookbackDays: config.lookbackDays,
  itemCount: items.length,
  failedCities,
  items
}, null, 2)}\n`);

if (!items.length) throw new Error(`No verified market intelligence items were generated. ${failedCities.map((item) => `${item.city}: ${item.error}`).join(' | ')}`);
