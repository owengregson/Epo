/** @jsx h */
import { h, render } from 'preact';
import './styles/index.css';
import { App } from './app/App';

const root = document.getElementById('app');
if (root) {
  render(<App />, root);
}
