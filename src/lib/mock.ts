import type {
  MessageId,
  BranchId,
  AnchorId,
  Message,
  Branch,
  Anchor,
  ChatState,
} from '../types';

// ---- Deterministic IDs for mock data ----
const ROOT_BRANCH = 'br_root' as BranchId;
const BRANCH_A = 'br_attention_deep' as BranchId;
const BRANCH_B = 'br_rnn_compare' as BranchId;

const MSG_1 = 'msg_1' as MessageId;
const MSG_2 = 'msg_2' as MessageId;
const MSG_3 = 'msg_3' as MessageId;
const MSG_4 = 'msg_4' as MessageId;

const MSG_A1 = 'msg_a1' as MessageId;
const MSG_A2 = 'msg_a2' as MessageId;

const MSG_B1 = 'msg_b1' as MessageId;
const MSG_B2 = 'msg_b2' as MessageId;

const ANCHOR_A = 'anc_attention' as AnchorId;
const ANCHOR_B = 'anc_rnn' as unknown as AnchorId;

// ---- Helper: find substring offset in raw markdown ----
function findSlice(content: string, searchText: string) {
  const idx = content.indexOf(searchText);
  if (idx === -1) return { startOffset: 0, endOffset: searchText.length, selectedText: searchText };
  return { startOffset: idx, endOffset: idx + searchText.length, selectedText: searchText };
}

// ---- MSG_2 content (shared ref for offset calculation) ----
const MSG_2_CONTENT = `## Transformer 架构核心原理

Transformer 是 2017 年由 Vaswani 等人在论文 *"Attention Is All You Need"* 中提出的架构。它彻底抛弃了循环结构，完全依赖 **自注意力机制（Self-Attention）** 来建模序列中任意两个位置之间的依赖关系。

### 1. 自注意力机制（Self-Attention）

核心思想是：对于输入序列中的每一个 token，计算它与所有其他 token 的"相关性分数"，然后用这些分数对 value 向量做加权求和。数学表达式为：

$$
\\text{Attention}(Q, K, V) = \\text{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V
$$

其中 Q（Query）、K（Key）、V（Value）是输入经过三个不同线性变换后的矩阵。除以 $\\sqrt{d_k}$ 是为了防止点积值过大导致 softmax 梯度消失。

### 2. 多头注意力（Multi-Head Attention）

单个注意力头只能捕获一种类型的依赖关系。多头注意力通过并行运行多个注意力头，让模型能够同时关注不同子空间的信息。每个头独立计算注意力后拼接再做线性投影。

### 3. 位置编码（Positional Encoding）

由于 Self-Attention 本身是置换不变的（permutation-invariant），无法感知 token 的顺序。Transformer 通过加入位置编码来注入位置信息。原始论文使用正弦/余弦函数：

$$
PE_{(pos, 2i)} = \\sin(pos / 10000^{2i/d})
$$

### 4. 为什么取代 RNN？

- **并行化能力**：RNN 必须按时间步顺序计算，而 Self-Attention 可以一次性并行处理整个序列，极大加速训练。
- **长距离依赖**：RNN 中信息需要逐步传递，长序列时容易出现梯度消失/爆炸。Self-Attention 允许任意两个位置直接交互，路径长度为 O(1)。
- **可扩展性**：Transformer 在参数量和数据量的 scaling law 上表现优异，催生了 GPT、BERT 等大模型范式。

### 5. 编码器-解码器结构

标准 Transformer 采用 Encoder-Decoder 结构。Encoder 对输入做双向注意力编码；Decoder 在生成时使用 Masked Self-Attention 确保自回归特性，并通过 Cross-Attention 关注 Encoder 输出。`;

// ---- Anchor slices ----
const sliceA = findSlice(MSG_2_CONTENT, '自注意力机制（Self-Attention）');
const sliceB = findSlice(MSG_2_CONTENT, '为什么取代 RNN？');

// ---- Anchors ----
const anchors: Record<string, Anchor> = {
  [ANCHOR_A]: {
    id: ANCHOR_A,
    messageId: MSG_2,
    slice: sliceA,
    branchId: BRANCH_A,
    intent: 'new-branch',
    color: '#34d399',
    status: 'done',
    pendingInput: '能不能更详细地推导一下 Scaled Dot-Product Attention 的数学过程？',
  },
  [ANCHOR_B]: {
    id: ANCHOR_B,
    messageId: MSG_2,
    slice: sliceB,
    branchId: BRANCH_B,
    intent: 'new-branch',
    color: '#34d399',
    status: 'done',
    pendingInput: 'RNN 和 Transformer 在不同任务上的性能对比数据有哪些？',
  },
};

// ---- Mock messages ----
const messages: Record<string, Message> = {
  // ====== Root branch ======
  [MSG_1]: {
    id: MSG_1,
    role: 'user',
    content:
      '请帮我解释一下 Transformer 架构的核心原理，以及它为什么能够取代 RNN 成为 NLP 的主流架构。',
    parentId: null,
    branchId: ROOT_BRANCH,
    anchorIds: [],
    createdAt: Date.now() - 60000,
  },
  [MSG_2]: {
    id: MSG_2,
    role: 'assistant',
    content: MSG_2_CONTENT,
    parentId: MSG_1,
    branchId: ROOT_BRANCH,
    anchorIds: [ANCHOR_A, ANCHOR_B],
    createdAt: Date.now() - 55000,
  },
  [MSG_3]: {
    id: MSG_3,
    role: 'user',
    content: '那 Flash Attention 是怎么优化注意力计算的？',
    parentId: MSG_2,
    branchId: ROOT_BRANCH,
    anchorIds: [],
    createdAt: Date.now() - 30000,
  },
  [MSG_4]: {
    id: MSG_4,
    role: 'assistant',
    content: `## Flash Attention 优化原理

Flash Attention 由 Dao 等人在 2022 年提出，核心思路是通过 **IO 感知（IO-Aware）** 的算法设计来避免标准注意力中的内存瓶颈。

### 问题：标准注意力的内存墙

标准 Self-Attention 需要将完整的 $N \\times N$ 注意力矩阵写入 GPU 的 HBM（高带宽显存），其中 N 是序列长度。对于长序列，这个矩阵巨大，而 GPU 的计算速度远快于 HBM 的读写速度，形成了 **内存带宽瓶颈**。

### 解决方案：分块计算 + Online Softmax

Flash Attention 的关键创新：

1. **Tiling（分块）**：将 Q、K、V 矩阵切分为小块，使其能装入 GPU 的 SRAM（片上缓存，速度比 HBM 快 10-100 倍）。
2. **在线 Softmax 技巧**：普通 softmax 需要看到一整行的值才能计算分母。Flash Attention 使用一种增量更新的方式，在逐块扫描 K 的过程中动态修正 softmax 的归一化因子。
3. **不显式存储注意力矩阵**：中间的 $N \\times N$ 矩阵从不写入 HBM，只在 SRAM 中短暂存在。

### 性能提升

- 内存复杂度从 $O(N^2)$ 降至 $O(N)$。
- 在 A100 GPU 上实现了 2-4 倍的端到端训练加速。
- Flash Attention 2 进一步优化了线程并行和 warp 级调度，效率接近理论峰值。

### 实际影响

几乎所有现代大模型训练框架（PyTorch 2.0+、DeepSpeed、Megatron-LM）都已集成 Flash Attention 作为默认后端。它使得训练百万级 token 的长上下文模型成为可能。`,
    parentId: MSG_3,
    branchId: ROOT_BRANCH,
    anchorIds: [],
    createdAt: Date.now() - 25000,
  },

  // ====== Branch A: Attention 数学推导 ======
  [MSG_A1]: {
    id: MSG_A1,
    role: 'user',
    content: '能不能更详细地推导一下 Scaled Dot-Product Attention 的数学过程？',
    parentId: null,
    branchId: BRANCH_A,
    anchorIds: [],
    createdAt: Date.now() - 50000,
  },
  [MSG_A2]: {
    id: MSG_A2,
    role: 'assistant',
    content:
      '当然，Scaled Dot-Product Attention 的完整推导如下……（此处省略详细推导过程）',
    parentId: MSG_A1,
    branchId: BRANCH_A,
    anchorIds: [],
    createdAt: Date.now() - 48000,
  },

  // ====== Branch B: RNN 对比 ======
  [MSG_B1]: {
    id: MSG_B1,
    role: 'user',
    content: 'RNN 和 Transformer 在不同任务上的性能对比数据有哪些？',
    parentId: null,
    branchId: BRANCH_B,
    anchorIds: [],
    createdAt: Date.now() - 45000,
  },
  [MSG_B2]: {
    id: MSG_B2,
    role: 'assistant',
    content:
      '以下是几项关键 benchmark 的对比数据……（此处省略对比表格）',
    parentId: MSG_B1,
    branchId: BRANCH_B,
    anchorIds: [],
    createdAt: Date.now() - 43000,
  },
};

// ---- Branches ----
const branches: Record<string, Branch> = {
  [ROOT_BRANCH]: {
    id: ROOT_BRANCH,
    label: '主干对话',
    sourceAnchorId: null,
    sourceMessageId: null,
    messageIds: [MSG_1, MSG_2, MSG_3, MSG_4],
    status: 'idle',
  },
  [BRANCH_A]: {
    id: BRANCH_A,
    label: 'Attention 数学推导',
    sourceAnchorId: ANCHOR_A,
    sourceMessageId: MSG_2,
    messageIds: [MSG_A1, MSG_A2],
    status: 'done',
  },
  [BRANCH_B]: {
    id: BRANCH_B,
    label: 'RNN vs Transformer 对比',
    sourceAnchorId: ANCHOR_B,
    sourceMessageId: MSG_2,
    messageIds: [MSG_B1, MSG_B2],
    status: 'done',
  },
};

export const mockState: Pick<
  ChatState,
  'messages' | 'anchors' | 'branches' | 'blackboard' | 'rootBranchId' | 'ui' | 'canvas'
> = {
  messages,
  anchors,
  branches,
  blackboard: {},
  rootBranchId: ROOT_BRANCH,
  ui: {
    viewMode: 'linear',
    activeBranchIds: [],
    focusedAnchorId: null,
    activeBranchPanelId: null,
    pendingSelection: null,
  },
  canvas: {
    nodes: [],
    edges: [],
    version: 0,
  },
};

export const emptyState: Pick<
  ChatState,
  'messages' | 'anchors' | 'branches' | 'blackboard' | 'rootBranchId' | 'ui' | 'canvas'
> = {
  messages: {},
  anchors: {},
  branches: {
    [ROOT_BRANCH]: {
      id: ROOT_BRANCH,
      label: '主干对话',
      sourceAnchorId: null,
      sourceMessageId: null,
      messageIds: [],
      status: 'idle',
    },
  },
  blackboard: {},
  rootBranchId: ROOT_BRANCH,
  ui: {
    viewMode: 'linear',
    activeBranchIds: [],
    focusedAnchorId: null,
    activeBranchPanelId: null,
    pendingSelection: null,
  },
  canvas: {
    nodes: [],
    edges: [],
    version: 0,
  },
};
