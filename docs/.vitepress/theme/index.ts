import DefaultTheme from 'vitepress/theme';
import Layout from './Layout.vue';
import AgentMacTerminal from './components/AgentMacTerminal.vue';
import InstallCommand from './components/InstallCommand.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component('AgentMacTerminal', AgentMacTerminal);
    app.component('InstallCommand', InstallCommand);
  }
};
