import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import CluedoxLandingPage from './pages/CluedoxLandingPage';
import './index.css';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<CluedoxLandingPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;