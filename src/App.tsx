import ProposalAgentPanel from './components/ProposalAgentPanel';

export default function App() {
  return (
    <main className="app-shell">
      <header className="page-header">
        <p className="eyebrow">Company Project Lookup</p>
        <h1>MYML Evidence Agent</h1>
        <p className="subtitle">项目编号 → 公司真实开发数据展示</p>
      </header>

      <ProposalAgentPanel />
    </main>
  );
}
