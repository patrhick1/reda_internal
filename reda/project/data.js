// Sample Reda data — realistic Lagos delivery operation.
window.REDA_DATA = (function () {
  const users = {
    'u-uzo':     { id: 'u-uzo',     role: 'admin',      name: 'Uzo Okeke',        initials: 'UO', phone: '+234 803 412 8870', color: '#0A0A0A' },
    'u-amaka':   { id: 'u-amaka',   role: 'dispatcher', name: 'Amaka Eze',        initials: 'AE', phone: '+234 805 220 4419', color: '#7A7A7A' },
    'u-kenneth': { id: 'u-kenneth', role: 'agent',      name: 'Kenneth Adebayo',  initials: 'KA', phone: '+234 813 998 2210', color: '#E63027' },
    'u-tunde':   { id: 'u-tunde',   role: 'agent',      name: 'Tunde Bello',      initials: 'TB', phone: '+234 811 442 9011', color: '#0A0A0A' },
    'u-ifeanyi': { id: 'u-ifeanyi', role: 'agent',      name: 'Ifeanyi Nwosu',    initials: 'IN', phone: '+234 902 778 1130', color: '#7A7A7A' },
    'u-blessing':{ id: 'u-blessing',role: 'agent',      name: 'Blessing Okoro',   initials: 'BO', phone: '+234 706 220 3398', color: '#E63027' },
    'u-segun':   { id: 'u-segun',   role: 'agent',      name: 'Segun Adeyemi',    initials: 'SA', phone: '+234 808 119 5520', color: '#0A0A0A' },
    'u-folake':  { id: 'u-folake',  role: 'warehouse',  name: 'Folake Ojo',       initials: 'FO', phone: '+234 810 220 6677', color: '#7A7A7A' },
  };

  const clients = [
    { id: 'c-dentora', name: 'Dentora',     contact: 'Mrs. Aniedi', notes: 'Do not deliver partial orders. Full quantity or reschedule.', activeProducts: 4 },
    { id: 'c-omolewa', name: 'Omolewa Hair', contact: 'Tope O.',     notes: 'Confirm bundle count on delivery. Returns within 24h only.', activeProducts: 8 },
    { id: 'c-bareek',  name: 'Bareek & Co',  contact: 'Nnamdi A.',   notes: 'COD only. No transfers accepted by customer request.', activeProducts: 3 },
    { id: 'c-vitalix', name: 'Vitalix',      contact: 'Mr. Okafor',  notes: 'Fragile — handle with care. Photograph parcel before handover.', activeProducts: 6 },
    { id: 'c-rosebel', name: 'Rose & Bel',   contact: 'Bisi K.',     notes: '', activeProducts: 2 },
  ];

  const locations = [
    { id: 'l-lekki1',   name: 'Lekki Phase 1',   rate: { charged: 2500, agent: 1200 } },
    { id: 'l-vi',       name: 'Victoria Island', rate: { charged: 2500, agent: 1200 } },
    { id: 'l-ikoyi',    name: 'Ikoyi',           rate: { charged: 2500, agent: 1200 } },
    { id: 'l-ajah',     name: 'Ajah',            rate: { charged: 3500, agent: 1800 } },
    { id: 'l-yaba',     name: 'Yaba',            rate: { charged: 3000, agent: 1500 } },
    { id: 'l-surulere', name: 'Surulere',        rate: { charged: 3000, agent: 1500 } },
    { id: 'l-ikeja',    name: 'Ikeja',           rate: { charged: 3500, agent: 1800 } },
    { id: 'l-maryland', name: 'Maryland',        rate: { charged: 3500, agent: 1800 } },
    { id: 'l-gbagada',  name: 'Gbagada',         rate: { charged: 3000, agent: 1500 } },
    { id: 'l-magodo',   name: 'Magodo',          rate: { charged: 4000, agent: 2000 } },
  ];

  const products = [
    { id: 'p-d-tooth', client: 'c-dentora', name: 'Whitening kit', price: 19000 },
    { id: 'p-d-floss', client: 'c-dentora', name: 'Floss bundle (3-pack)', price: 8500 },
    { id: 'p-o-bone',  client: 'c-omolewa', name: 'Bone straight 22"', price: 145000 },
    { id: 'p-o-curly', client: 'c-omolewa', name: 'Loose curl 18"', price: 95000 },
    { id: 'p-b-bag',   client: 'c-bareek',  name: 'Tote bag — sand', price: 32000 },
    { id: 'p-v-c',     client: 'c-vitalix', name: 'Vitamin C 1000mg', price: 12000 },
    { id: 'p-v-multi', client: 'c-vitalix', name: 'Daily multivitamin', price: 15500 },
  ];

  // Today's deliveries — Kenneth has 6
  const today = '2026-05-13';
  const deliveries = [
    {
      id: 'd-001', code: 'RD-2842',
      customer: 'Adegboye Akoro', phone: '+234 805 119 4422',
      rawAddress: '17 Admiralty Way, near Ebeano Supermarket',
      locationId: 'l-lekki1',
      clientId: 'c-dentora', productId: 'p-d-tooth', qty: 1,
      customerPrice: 19000, charged: 2500, agentPayment: 1200,
      status: 'available', agentId: 'u-kenneth', scheduledFor: today,
      createdVia: 'bot',
      botRaw: 'Hi, please deliver 1x whitening kit to Mr. Akoro, 17 Admiralty Way near Ebeano. ₦19k cash. Call when close — 0805 119 4422',
      history: [
        { at: '07:42', status: 'pending', actor: 'Bot', note: 'Created from WhatsApp message' },
        { at: '08:15', status: 'available', actor: 'Kenneth Adebayo', note: 'Customer confirmed, dropping by 11am' },
      ],
    },
    {
      id: 'd-002', code: 'RD-2843',
      customer: 'Funmi Ogun', phone: '+234 802 778 1109',
      rawAddress: 'Block 22 Flat 4, 1004 Estate, Victoria Island',
      locationId: 'l-vi',
      clientId: 'c-omolewa', productId: 'p-o-bone', qty: 1,
      customerPrice: 145000, charged: 2500, agentPayment: 1200,
      status: 'pending', agentId: 'u-kenneth', scheduledFor: today,
      createdVia: 'bot',
      history: [{ at: '08:01', status: 'pending', actor: 'Bot', note: 'Created from WhatsApp message' }],
    },
    {
      id: 'd-003', code: 'RD-2844',
      customer: 'Chinedu Mba', phone: '+234 813 552 7741',
      rawAddress: '4 Bourdillon Road, Ikoyi (interphone 12)',
      locationId: 'l-ikoyi',
      clientId: 'c-bareek', productId: 'p-b-bag', qty: 2,
      customerPrice: 64000, charged: 2500, agentPayment: 1200,
      status: 'number_busy', agentId: 'u-kenneth', scheduledFor: today,
      createdVia: 'manual',
      history: [
        { at: '07:50', status: 'pending', actor: 'Amaka Eze', note: 'Created from call' },
        { at: '09:12', status: 'available', actor: 'Kenneth Adebayo', note: '' },
        { at: '10:05', status: 'number_busy', actor: 'Kenneth Adebayo', note: 'Tried 3 times, line busy' },
      ],
    },
    {
      id: 'd-004', code: 'RD-2845',
      customer: 'Mrs. Adeyemi', phone: '+234 706 410 2289',
      rawAddress: 'House 8, Goshen Estate, Ajah',
      locationId: 'l-ajah',
      clientId: 'c-vitalix', productId: 'p-v-c', qty: 3,
      customerPrice: 36000, charged: 3500, agentPayment: 1800,
      status: 'delivered', agentId: 'u-kenneth', scheduledFor: today,
      deliveredQty: 3, paid: 36000, paymentMethod: 'transfer',
      createdVia: 'bot',
      history: [
        { at: '08:30', status: 'pending', actor: 'Bot', note: '' },
        { at: '09:05', status: 'available', actor: 'Kenneth Adebayo', note: '' },
        { at: '11:48', status: 'delivered', actor: 'Kenneth Adebayo', note: '₦36,000 transfer received' },
      ],
    },
    {
      id: 'd-005', code: 'RD-2846',
      customer: 'Tobi Salau', phone: '+234 902 113 9087',
      rawAddress: '12 Norman Williams St, off Awolowo Rd, Ikoyi',
      locationId: 'l-ikoyi',
      clientId: 'c-omolewa', productId: 'p-o-curly', qty: 1,
      customerPrice: 95000, charged: 2500, agentPayment: 1200,
      status: 'tomorrow', agentId: 'u-kenneth', scheduledFor: today,
      createdVia: 'manual',
      history: [
        { at: '08:14', status: 'pending', actor: 'Amaka Eze', note: '' },
        { at: '12:20', status: 'tomorrow', actor: 'Kenneth Adebayo', note: 'Customer travelling, prefers tomorrow' },
      ],
    },
    {
      id: 'd-006', code: 'RD-2847',
      customer: 'Femi Adesina', phone: '+234 811 998 5520',
      rawAddress: 'Plot 7, Awoyaya Rd, Ajah (after Mayfair Gardens)',
      locationId: 'l-ajah',
      clientId: 'c-dentora', productId: 'p-d-floss', qty: 2,
      customerPrice: 17000, charged: 3500, agentPayment: 1800,
      status: 'pending', agentId: 'u-kenneth', scheduledFor: today,
      createdVia: 'bot',
      history: [{ at: '08:33', status: 'pending', actor: 'Bot', note: '' }],
    },
    // Other agents' deliveries (visible to admin/dispatcher)
    {
      id: 'd-007', code: 'RD-2848',
      customer: 'Olumide Salami', phone: '+234 805 778 4419',
      rawAddress: '23 Allen Avenue, Ikeja',
      locationId: 'l-ikeja',
      clientId: 'c-vitalix', productId: 'p-v-multi', qty: 1,
      customerPrice: 15500, charged: 3500, agentPayment: 1800,
      status: 'available', agentId: 'u-tunde', scheduledFor: today,
      createdVia: 'bot',
      history: [{ at: '08:11', status: 'pending', actor: 'Bot', note: '' }],
    },
    {
      id: 'd-008', code: 'RD-2849',
      customer: 'Damilola Akin', phone: '+234 813 559 1144',
      rawAddress: '5b Olu Holloway, near Total filling station, Surulere',
      locationId: 'l-surulere',
      clientId: 'c-omolewa', productId: 'p-o-bone', qty: 1,
      customerPrice: 145000, charged: 3000, agentPayment: 1500,
      status: 'delivered', agentId: 'u-blessing', scheduledFor: today,
      deliveredQty: 1, paid: 145000, paymentMethod: 'transfer',
      createdVia: 'bot',
      history: [{ at: '12:01', status: 'delivered', actor: 'Blessing Okoro', note: '' }],
    },
    {
      id: 'd-009', code: 'RD-2850',
      customer: 'Hauwa Mohammed', phone: '+234 803 110 8822',
      rawAddress: 'Lugbe corner shop near filling station',  // ambiguous → needs review
      locationId: null,
      clientId: 'c-vitalix', productId: 'p-v-c', qty: 2,
      customerPrice: 24000, charged: null, agentPayment: null,
      status: 'pending', agentId: null, scheduledFor: today,
      createdVia: 'bot', needsReview: 'address',
      aiConfidence: 'low',
      botRaw: 'Pls deliver vitamin C × 2 to Hauwa, Lugbe corner shop near filling station. Customer 0803 110 8822. ₦24k cash on delivery.',
      history: [{ at: '08:47', status: 'pending', actor: 'Bot', note: 'AI could not match address' }],
    },
    {
      id: 'd-010', code: 'RD-2851',
      customer: 'Yemisi Bankole', phone: '+234 805 220 1109',
      rawAddress: '12 Glover Rd, Ikoyi (gatehouse)',
      locationId: 'l-ikoyi',
      clientId: 'c-bareek', productId: 'p-b-bag', qty: 1,
      customerPrice: 32000, charged: 2500, agentPayment: 1200,
      status: 'available', agentId: 'u-ifeanyi', scheduledFor: today,
      createdVia: 'manual',
      history: [{ at: '09:14', status: 'pending', actor: 'Amaka Eze', note: '' }],
    },
  ];

  // Agent stock — per (agent, product)
  const stock = [
    { agentId: 'u-kenneth', productId: 'p-d-tooth', qty: 8 },
    { agentId: 'u-kenneth', productId: 'p-d-floss', qty: 14 },
    { agentId: 'u-kenneth', productId: 'p-o-bone',  qty: 2 },
    { agentId: 'u-kenneth', productId: 'p-o-curly', qty: 3 },
    { agentId: 'u-kenneth', productId: 'p-b-bag',   qty: 4 },
    { agentId: 'u-kenneth', productId: 'p-v-c',     qty: 6 }, // 3 after today's delivery
    { agentId: 'u-tunde',   productId: 'p-v-multi', qty: 5 },
    { agentId: 'u-tunde',   productId: 'p-d-tooth', qty: 3 },
    { agentId: 'u-blessing',productId: 'p-o-bone',  qty: 1 },
    { agentId: 'u-ifeanyi', productId: 'p-b-bag',   qty: 5 },
    { agentId: 'u-segun',   productId: 'p-v-c',     qty: 4 },
    { agentId: 'warehouse', productId: 'p-d-tooth', qty: 24 },
    { agentId: 'warehouse', productId: 'p-d-floss', qty: 60 },
    { agentId: 'warehouse', productId: 'p-o-bone',  qty: 12 },
    { agentId: 'warehouse', productId: 'p-o-curly', qty: 8 },
    { agentId: 'warehouse', productId: 'p-b-bag',   qty: 18 },
    { agentId: 'warehouse', productId: 'p-v-c',     qty: 32 },
    { agentId: 'warehouse', productId: 'p-v-multi', qty: 14 },
  ];

  return { users, clients, locations, products, deliveries, stock };
})();
