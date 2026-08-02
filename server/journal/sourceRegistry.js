const dblpFallback = (path) => ({
  kind: "dblp-index",
  url: `https://dblp.org${path}`,
});

export const SOURCE_REGISTRY_VERSION = 1;

export const SOURCE_REGISTRY = Object.freeze([
  {
    source_id: "journal-ai",
    id: "journal-ai",
    venue: "Artificial Intelligence",
    name: "Artificial Intelligence",
    short_name: "AI",
    source_type: "journal",
    type: "journal",
    primary: {
      kind: "publisher-index",
      url: "https://www.sciencedirect.com/journal/artificial-intelligence",
    },
    fallback: {
      kind: "crossref-api",
      url: "https://api.crossref.org/journals/0004-3702/works",
    },
    adapter: "sciencedirect-journal",
    dblp_path: "journals/ai",
    openalex_source_id: "S196139623",
  },
  {
    source_id: "journal-tpami",
    id: "journal-tpami",
    venue: "IEEE Transactions on Pattern Analysis and Machine Intelligence",
    name: "IEEE Transactions on Pattern Analysis and Machine Intelligence",
    short_name: "TPAMI",
    source_type: "journal",
    type: "journal",
    primary: {
      kind: "publisher-index",
      url: "https://ieeexplore.ieee.org/xpl/RecentIssue.jsp?punumber=34",
    },
    fallback: {
      kind: "crossref-api",
      url: "https://api.crossref.org/journals/0162-8828/works",
    },
    adapter: "ieee-recent-issue",
    dblp_path: "journals/pami",
    openalex_source_id: "S199944782",
  },
  {
    source_id: "journal-ijcv",
    id: "journal-ijcv",
    venue: "International Journal of Computer Vision",
    name: "International Journal of Computer Vision",
    short_name: "IJCV",
    source_type: "journal",
    type: "journal",
    primary: {
      kind: "publisher-index",
      url: "https://link.springer.com/journal/11263/articles",
    },
    fallback: {
      kind: "crossref-api",
      url: "https://api.crossref.org/journals/0920-5691/works",
    },
    adapter: "springer-journal",
    dblp_path: "journals/ijcv",
    openalex_source_id: "S25538012",
  },
  {
    source_id: "journal-jmlr",
    id: "journal-jmlr",
    venue: "Journal of Machine Learning Research",
    name: "Journal of Machine Learning Research",
    short_name: "JMLR",
    source_type: "journal",
    type: "journal",
    primary: {
      kind: "official-index",
      url: "https://www.jmlr.org/papers/",
    },
    fallback: {
      kind: "crossref-api",
      url: "https://api.crossref.org/journals/1532-4435/works",
    },
    adapter: "jmlr-papers-index",
    dblp_path: "journals/jmlr",
    openalex_source_id: "S118988714",
  },
  {
    source_id: "conference-aaai",
    id: "conference-aaai",
    venue: "AAAI Conference on Artificial Intelligence",
    name: "AAAI Conference on Artificial Intelligence",
    short_name: "AAAI",
    source_type: "conference",
    type: "conference",
    primary: {
      kind: "official-proceedings",
      url: "https://ojs.aaai.org/index.php/AAAI/issue/archive",
    },
    fallback: dblpFallback("/db/conf/aaai/"),
    adapter: "aaai-ojs-archive",
    dblp_path: "conf/aaai",
    openalex_source_id: "S4210191458",
  },
  {
    source_id: "conference-neurips",
    id: "conference-neurips",
    venue: "Conference on Neural Information Processing Systems",
    name: "Conference on Neural Information Processing Systems",
    short_name: "NeurIPS",
    source_type: "conference",
    type: "conference",
    primary: {
      kind: "official-proceedings",
      url: "https://proceedings.neurips.cc/",
    },
    fallback: dblpFallback("/db/conf/nips/"),
    adapter: "neurips-proceedings",
    dblp_path: "conf/nips",
    openalex_source_id: "S4306420609",
  },
  {
    source_id: "conference-acl",
    id: "conference-acl",
    venue: "Annual Meeting of the Association for Computational Linguistics",
    name: "Annual Meeting of the Association for Computational Linguistics",
    short_name: "ACL",
    source_type: "conference",
    type: "conference",
    primary: {
      kind: "official-anthology",
      url: "https://aclanthology.org/venues/acl/",
    },
    fallback: dblpFallback("/db/conf/acl/"),
    adapter: "acl-anthology-venue",
    dblp_path: "conf/acl",
    openalex_source_id: "S4306420508",
  },
  {
    source_id: "conference-cvpr",
    id: "conference-cvpr",
    venue: "IEEE/CVF Conference on Computer Vision and Pattern Recognition",
    name: "IEEE/CVF Conference on Computer Vision and Pattern Recognition",
    short_name: "CVPR",
    source_type: "conference",
    type: "conference",
    primary: {
      kind: "official-open-access",
      url: "https://openaccess.thecvf.com/menu",
    },
    fallback: dblpFallback("/db/conf/cvpr/"),
    adapter: "cvf-cvpr",
    dblp_path: "conf/cvpr",
  },
  {
    source_id: "conference-iccv",
    id: "conference-iccv",
    venue: "International Conference on Computer Vision",
    name: "International Conference on Computer Vision",
    short_name: "ICCV",
    source_type: "conference",
    type: "conference",
    primary: {
      kind: "official-open-access",
      url: "https://openaccess.thecvf.com/menu",
    },
    fallback: dblpFallback("/db/conf/iccv/"),
    adapter: "cvf-iccv",
    dblp_path: "conf/iccv",
  },
  {
    source_id: "conference-icml",
    id: "conference-icml",
    venue: "International Conference on Machine Learning",
    name: "International Conference on Machine Learning",
    short_name: "ICML",
    source_type: "conference",
    type: "conference",
    primary: {
      kind: "official-proceedings",
      url: "https://proceedings.mlr.press/",
    },
    fallback: dblpFallback("/db/conf/icml/"),
    adapter: "pmlr-proceedings",
    dblp_path: "conf/icml",
    openalex_source_id: "S4306419644",
  },
  {
    source_id: "conference-iclr",
    id: "conference-iclr",
    venue: "International Conference on Learning Representations",
    name: "International Conference on Learning Representations",
    short_name: "ICLR",
    source_type: "conference",
    type: "conference",
    primary: {
      kind: "official-openreview",
      url: "https://openreview.net/group?id=ICLR.cc",
    },
    fallback: dblpFallback("/db/conf/iclr/"),
    adapter: "openreview-iclr",
    dblp_path: "conf/iclr",
    openalex_source_id: "S4306419637",
  },
]);

export function validateSourceRegistry(sources = SOURCE_REGISTRY) {
  if (!Array.isArray(sources)) {
    return { valid: false, errors: ["来源注册表必须是数组"] };
  }

  const errors = [];
  const ids = new Set();
  for (const [index, source] of sources.entries()) {
    const prefix = `sources[${index}]`;
    if (!source?.source_id || ids.has(source.source_id)) {
      errors.push(`${prefix}.source_id 缺失或重复`);
    } else {
      ids.add(source.source_id);
    }
    for (const field of ["venue", "short_name", "source_type", "adapter", "dblp_path"]) {
      if (typeof source?.[field] !== "string" || source[field].trim() === "") {
        errors.push(`${prefix}.${field} 必须是非空字符串`);
      }
    }
    for (const route of ["primary", "fallback"]) {
      if (
        typeof source?.[route]?.kind !== "string"
        || !URL.canParse(source?.[route]?.url)
        || !source[route].url.startsWith("https://")
      ) {
        errors.push(`${prefix}.${route} 必须包含 HTTPS URL 与类型`);
      }
    }
    if (typeof source?.dblp_path === "string" && !/^(?:journals|conf)\/[a-z0-9-]+$/.test(source.dblp_path)) {
      errors.push(`${prefix}.dblp_path 必须是 DBLP 相对路径`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function getSourceById(sourceId) {
  return SOURCE_REGISTRY.find((source) => source.source_id === sourceId) ?? null;
}
