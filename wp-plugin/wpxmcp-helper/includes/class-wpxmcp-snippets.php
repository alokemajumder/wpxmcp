<?php
/**
 * Code snippets.
 *
 * PHP, CSS and JS added here run without touching theme files, so they survive
 * theme updates and can be switched off without editing code. Snippets are
 * always created DISABLED: a human enables them in wp-admin after reading the
 * code, which means an agent can never make code execute on a live site by
 * itself.
 *
 * @package wpxmcp
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Snippet storage and execution.
 */
class WPXMCP_Snippets {

	/**
	 * Singleton.
	 *
	 * @var WPXMCP_Snippets|null
	 */
	private static $instance = null;

	/**
	 * Option holding all snippets.
	 */
	const OPTION = 'wpxmcp_snippets';

	/**
	 * Accessor.
	 *
	 * @return WPXMCP_Snippets
	 */
	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Hook up.
	 */
	private function __construct() {
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );
		add_action( 'admin_menu', array( $this, 'add_admin_page' ) );

		// PHP snippets run as early as is useful; CSS and JS are enqueued.
		add_action( 'plugins_loaded', array( $this, 'run_php_snippets' ), 20 );
		add_action( 'wp_head', array( $this, 'output_head' ), 99 );
		add_action( 'wp_footer', array( $this, 'output_footer' ), 99 );
	}

	/**
	 * All snippets.
	 *
	 * @return array
	 */
	public static function all() {
		$snippets = get_option( self::OPTION, array() );
		return is_array( $snippets ) ? $snippets : array();
	}

	/**
	 * Routes.
	 */
	public function register_routes() {
		$admin = array( WPXMCP_REST::instance(), 'require_admin' );

		register_rest_route( WPXMCP_NAMESPACE, '/snippets', array(
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( $this, 'rest_list' ),
				'permission_callback' => $admin,
			),
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( $this, 'rest_create' ),
				'permission_callback' => $admin,
			),
		) );

		register_rest_route( WPXMCP_NAMESPACE, '/snippets/(?P<id>[a-zA-Z0-9_\-]+)', array(
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( $this, 'rest_get' ),
				'permission_callback' => $admin,
			),
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( $this, 'rest_update' ),
				'permission_callback' => $admin,
			),
			array(
				'methods'             => WP_REST_Server::DELETABLE,
				'callback'            => array( $this, 'rest_delete' ),
				'permission_callback' => $admin,
			),
		) );
	}

	/**
	 * List snippets.
	 *
	 * @return array
	 */
	public function rest_list() {
		$snippets = self::all();
		$out      = array();

		foreach ( $snippets as $id => $snippet ) {
			$out[] = array(
				'id'       => $id,
				'title'    => $snippet['title'],
				'language' => $snippet['language'],
				'location' => $snippet['location'],
				'active'   => (bool) $snippet['active'],
				'lines'    => substr_count( $snippet['code'], "\n" ) + 1,
				'updated'  => $snippet['updated'] ?? null,
			);
		}

		return array( 'count' => count( $out ), 'snippets' => $out );
	}

	/**
	 * One snippet, with its code.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function rest_get( $request ) {
		$id       = sanitize_key( (string) $request->get_param( 'id' ) );
		$snippets = self::all();

		if ( ! isset( $snippets[ $id ] ) ) {
			return new WP_Error( 'wpxmcp_no_snippet', sprintf( 'No snippet "%s".', $id ), array( 'status' => 404 ) );
		}
		return array_merge( array( 'id' => $id ), $snippets[ $id ] );
	}

	/**
	 * Create a snippet, always disabled.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function rest_create( $request ) {
		$title    = sanitize_text_field( (string) $request->get_param( 'title' ) );
		$code     = (string) $request->get_param( 'code' );
		$language = (string) $request->get_param( 'language' );
		$language = in_array( $language, array( 'php', 'css', 'js', 'html' ), true ) ? $language : 'php';
		$location = (string) $request->get_param( 'location' );
		$location = in_array( $location, array( 'everywhere', 'frontend', 'admin', 'header', 'footer' ), true ) ? $location : 'everywhere';

		if ( '' === $title || '' === trim( $code ) ) {
			return new WP_Error( 'wpxmcp_missing', 'Both `title` and `code` are required.', array( 'status' => 400 ) );
		}

		if ( 'php' === $language ) {
			$check = $this->check_php( $code );
			if ( is_wp_error( $check ) ) {
				return $check;
			}
		}

		$id             = sanitize_key( $title ) . '-' . substr( md5( $title . microtime() ), 0, 6 );
		$snippets       = self::all();
		$snippets[ $id ] = array(
			'title'       => $title,
			'code'        => $code,
			'language'    => $language,
			'location'    => $location,
			'description' => sanitize_text_field( (string) $request->get_param( 'description' ) ),
			// Always disabled on creation. A human turns it on in wp-admin.
			'active'      => false,
			'created'     => gmdate( 'c' ),
			'updated'     => gmdate( 'c' ),
		);

		update_option( self::OPTION, $snippets );
		wpxmcp_audit( 'snippet create', array( 'id' => $id, 'language' => $language ) );

		return array(
			'id'        => $id,
			'title'     => $title,
			'language'  => $language,
			'active'    => false,
			'admin_url' => admin_url( 'tools.php?page=wpxmcp-snippets' ),
			'note'      => 'Saved disabled and not running. Review the code in wp-admin (Tools → Code Snippets) and activate it there.',
		);
	}

	/**
	 * Update a snippet. Activation is deliberately not exposed over REST.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function rest_update( $request ) {
		$id       = sanitize_key( (string) $request->get_param( 'id' ) );
		$snippets = self::all();

		if ( ! isset( $snippets[ $id ] ) ) {
			return new WP_Error( 'wpxmcp_no_snippet', sprintf( 'No snippet "%s".', $id ), array( 'status' => 404 ) );
		}

		$code = $request->get_param( 'code' );
		if ( null !== $code ) {
			if ( 'php' === $snippets[ $id ]['language'] ) {
				$check = $this->check_php( (string) $code );
				if ( is_wp_error( $check ) ) {
					return $check;
				}
			}
			$snippets[ $id ]['code'] = (string) $code;
		}

		foreach ( array( 'title', 'description' ) as $key ) {
			$value = $request->get_param( $key );
			if ( null !== $value ) {
				$snippets[ $id ][ $key ] = sanitize_text_field( (string) $value );
			}
		}

		$location = $request->get_param( 'location' );
		if ( null !== $location && in_array( $location, array( 'everywhere', 'frontend', 'admin', 'header', 'footer' ), true ) ) {
			$snippets[ $id ]['location'] = $location;
		}

		$snippets[ $id ]['updated'] = gmdate( 'c' );
		update_option( self::OPTION, $snippets );
		wpxmcp_audit( 'snippet update', array( 'id' => $id ) );

		return array_merge(
			array( 'id' => $id, 'updated' => true ),
			$snippets[ $id ],
			array( 'note' => 'Activation state is unchanged — snippets can only be enabled from wp-admin.' )
		);
	}

	/**
	 * Delete a snippet.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function rest_delete( $request ) {
		$id       = sanitize_key( (string) $request->get_param( 'id' ) );
		$snippets = self::all();

		if ( ! isset( $snippets[ $id ] ) ) {
			return new WP_Error( 'wpxmcp_no_snippet', sprintf( 'No snippet "%s".', $id ), array( 'status' => 404 ) );
		}

		unset( $snippets[ $id ] );
		update_option( self::OPTION, $snippets );
		wpxmcp_audit( 'snippet delete', array( 'id' => $id ) );

		return array( 'deleted' => true, 'id' => $id );
	}

	/**
	 * Lint PHP without running it.
	 *
	 * @param string $code Snippet body.
	 * @return true|WP_Error
	 */
	private function check_php( $code ) {
		$source = ( 0 === strpos( ltrim( $code ), '<?php' ) ) ? $code : "<?php\n" . $code;
		try {
			$tokens = @token_get_all( $source, TOKEN_PARSE );
			unset( $tokens );
		} catch ( ParseError $e ) {
			return new WP_Error(
				'wpxmcp_php_syntax',
				sprintf( 'The snippet was not saved: PHP syntax error — %s on line %d.', $e->getMessage(), $e->getLine() ),
				array( 'status' => 400 )
			);
		} catch ( Throwable $e ) {
			return true;
		}
		return true;
	}

	/**
	 * Execute active PHP snippets.
	 */
	public function run_php_snippets() {
		foreach ( self::all() as $id => $snippet ) {
			if ( empty( $snippet['active'] ) || 'php' !== $snippet['language'] ) {
				continue;
			}
			if ( 'admin' === $snippet['location'] && ! is_admin() ) {
				continue;
			}
			if ( 'frontend' === $snippet['location'] && is_admin() ) {
				continue;
			}

			try {
				// phpcs:ignore Squiz.PHP.Eval.Discouraged
				eval( preg_replace( '/^\s*<\?php/', '', $snippet['code'] ) );
			} catch ( Throwable $e ) {
				// A broken snippet disables itself rather than fataling every request.
				$snippets                       = self::all();
				$snippets[ $id ]['active']      = false;
				$snippets[ $id ]['last_error']  = $e->getMessage();
				update_option( self::OPTION, $snippets );

				if ( defined( 'WP_DEBUG' ) && WP_DEBUG ) {
					error_log( sprintf( '[wpxmcp] Snippet "%s" threw and was disabled: %s', $id, $e->getMessage() ) ); // phpcs:ignore
				}
			}
		}
	}

	/**
	 * CSS and JS destined for the head.
	 */
	public function output_head() {
		$this->output_assets( array( 'everywhere', 'frontend', 'header' ) );
	}

	/**
	 * JS destined for the footer.
	 */
	public function output_footer() {
		$this->output_assets( array( 'footer' ) );
	}

	/**
	 * Print active CSS/JS snippets for the given locations.
	 *
	 * @param array $locations Locations to print.
	 */
	private function output_assets( $locations ) {
		foreach ( self::all() as $snippet ) {
			if ( empty( $snippet['active'] ) || ! in_array( $snippet['location'], $locations, true ) ) {
				continue;
			}
			if ( 'css' === $snippet['language'] ) {
				echo "\n<style id=\"wpxmcp-snippet\">\n" . wp_strip_all_tags( $snippet['code'] ) . "\n</style>\n"; // phpcs:ignore WordPress.Security.EscapeOutput
			} elseif ( 'js' === $snippet['language'] ) {
				echo "\n<script id=\"wpxmcp-snippet\">\n" . $snippet['code'] . "\n</script>\n"; // phpcs:ignore WordPress.Security.EscapeOutput
			}
		}
	}

	/**
	 * Admin screen — the only place a snippet can be activated.
	 */
	public function add_admin_page() {
		add_management_page(
			__( 'Code Snippets', 'wpxmcp' ),
			__( 'Code Snippets', 'wpxmcp' ),
			'manage_options',
			'wpxmcp-snippets',
			array( $this, 'render_admin_page' )
		);
	}

	/**
	 * Render the snippet screen.
	 */
	public function render_admin_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}

		// phpcs:ignore WordPress.Security.NonceVerification.Missing
		if ( isset( $_POST['wpxmcp_snippet_nonce'] ) && wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST['wpxmcp_snippet_nonce'] ) ), 'wpxmcp_snippets' ) ) {
			// phpcs:ignore WordPress.Security.NonceVerification.Missing
			$active   = isset( $_POST['active'] ) ? array_map( 'sanitize_key', (array) wp_unslash( $_POST['active'] ) ) : array();
			$snippets = self::all();

			foreach ( $snippets as $id => $snippet ) {
				$snippets[ $id ]['active'] = in_array( $id, $active, true );
			}
			update_option( self::OPTION, $snippets );
			wpxmcp_audit( 'snippet activation changed', array( 'active' => $active ) );
			echo '<div class="notice notice-success is-dismissible"><p>' . esc_html__( 'Snippet activation updated.', 'wpxmcp' ) . '</p></div>';
		}

		$snippets = self::all();
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'Code Snippets', 'wpxmcp' ); ?></h1>
			<p class="description">
				<?php esc_html_e( 'Snippets added through wpxmcp always arrive disabled. Read the code before enabling anything — an active PHP snippet runs on every request.', 'wpxmcp' ); ?>
			</p>

			<?php if ( empty( $snippets ) ) : ?>
				<p><?php esc_html_e( 'No snippets have been added.', 'wpxmcp' ); ?></p>
			<?php else : ?>
				<form method="post">
					<?php wp_nonce_field( 'wpxmcp_snippets', 'wpxmcp_snippet_nonce' ); ?>
					<table class="widefat striped">
						<thead>
							<tr>
								<th style="width:80px"><?php esc_html_e( 'Active', 'wpxmcp' ); ?></th>
								<th><?php esc_html_e( 'Snippet', 'wpxmcp' ); ?></th>
							</tr>
						</thead>
						<tbody>
						<?php foreach ( $snippets as $id => $snippet ) : ?>
							<tr>
								<td>
									<input type="checkbox" name="active[]" value="<?php echo esc_attr( $id ); ?>" <?php checked( ! empty( $snippet['active'] ) ); ?>>
								</td>
								<td>
									<strong><?php echo esc_html( $snippet['title'] ); ?></strong>
									<span class="description">
										(<?php echo esc_html( $snippet['language'] ); ?>, <?php echo esc_html( $snippet['location'] ); ?>)
									</span>
									<?php if ( ! empty( $snippet['description'] ) ) : ?>
										<p class="description"><?php echo esc_html( $snippet['description'] ); ?></p>
									<?php endif; ?>
									<?php if ( ! empty( $snippet['last_error'] ) ) : ?>
										<p style="color:#d63638">
											<?php
											printf(
												/* translators: %s: error message. */
												esc_html__( 'This snippet threw an error and was disabled automatically: %s', 'wpxmcp' ),
												esc_html( $snippet['last_error'] )
											);
											?>
										</p>
									<?php endif; ?>
									<pre style="max-height:220px;overflow:auto;background:#f6f7f7;padding:10px;border-radius:4px;margin-top:8px"><?php echo esc_html( $snippet['code'] ); ?></pre>
								</td>
							</tr>
						<?php endforeach; ?>
						</tbody>
					</table>
					<?php submit_button( __( 'Save activation', 'wpxmcp' ) ); ?>
				</form>
			<?php endif; ?>
		</div>
		<?php
	}
}
