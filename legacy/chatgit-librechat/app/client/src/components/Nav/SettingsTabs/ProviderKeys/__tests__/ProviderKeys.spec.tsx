import userEvent from '@testing-library/user-event';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TEndpointsConfig } from 'librechat-data-provider';
import { fireEvent, render, screen, waitFor } from 'test/layout-test-utils';
import ProviderKeys from '../ProviderKeys';

let mockLocalMode = false;
let mockEndpoints: TEndpointsConfig = {};
let mockLoading = false;
let mockError = false;
const mockRefetch = jest.fn();

jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  useGetEndpointsQuery: () => ({
    data: mockEndpoints,
    isLoading: mockLoading,
    isError: mockError,
    refetch: mockRefetch,
  }),
  useGetStartupConfig: () => ({ data: {} }),
  useLocalModeQuery: () => ({ data: { localMode: mockLocalMode } }),
}));

jest.mock('librechat-data-provider/react-query', () => ({
  ...jest.requireActual('librechat-data-provider/react-query'),
  useUserKeyQuery: () => ({ data: { expiresAt: null } }),
}));

describe('ProviderKeys', () => {
  afterEach(() => {
    mockLocalMode = false;
    mockEndpoints = {};
    mockLoading = false;
    mockError = false;
    mockRefetch.mockClear();
  });

  it('shows personal connections directly without a second management dialog', () => {
    mockLocalMode = true;
    mockEndpoints = {
      'OpenAI-Compatible': {
        type: EModelEndpoint.custom,
        userProvide: true,
        userProvideURL: true,
        order: 0,
      },
    };
    render(<ProviderKeys />);
    expect(screen.getByText('OpenAI-Compatible')).toBeInTheDocument();
    expect(
      screen.getByText('Connect your ChatGPT plan, or enter an API key and model service address.'),
    ).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Model connections' })).not.toBeInTheDocument();
  });

  it('explains an empty personal connection list', () => {
    mockLocalMode = true;
    render(<ProviderKeys />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'No personal model connections are available in this configuration.',
    );
  });

  it('does not present a loading connection list as empty', () => {
    mockLocalMode = true;
    mockLoading = true;
    render(<ProviderKeys />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(screen.queryByText(/No personal model connections/)).not.toBeInTheDocument();
  });

  it('offers retry when personal connections fail to load', async () => {
    mockLocalMode = true;
    mockError = true;
    render(<ProviderKeys />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load your model connections');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('keeps help hidden until its trigger receives focus', async () => {
    render(<ProviderKeys />);

    await userEvent.click(screen.getByRole('button', { name: 'Model connections' }));

    const dialog = screen.getByRole('dialog');
    const helpText = 'Connect your ChatGPT plan, or enter an API key and model service address.';
    const helpTrigger = screen.getByLabelText(helpText);

    await waitFor(() => expect(dialog).toHaveFocus());
    expect(screen.queryByText(helpText)).not.toBeInTheDocument();

    fireEvent.focus(helpTrigger);
    expect(await screen.findByText(helpText)).toBeVisible();
  });
});
