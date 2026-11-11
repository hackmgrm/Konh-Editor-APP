import TongYunApp from './tongyun/App';
import './tongyun/index.css';

/** All windows use TongYun's shell; auxiliary windows keep their own views. */
export default function KonhShell() {
  return <TongYunApp />;
}
