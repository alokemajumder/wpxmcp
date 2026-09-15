<?php
/**
 * Operating installed plugins as an administrator: settings, admin screens and their forms.
 *
 * Most plugin configuration (Yoast, Rank Math, WooCommerce, and so on) lives on
 * wp-admin screens that post to options.php or admin-post.php and expose no REST
 * route. This class lets an authenticated administrator drive those screens over
 * MCP:
 *
 *   - GET  /plugins/inspect          — everything a plugin exposes and how to control it.
 *   - GET  /plugins/settings         — read an owned option (secrets redacted).
 *   - POST /plugins/settings         — write an owned option through update_option().
 *   - POST /plugins/settings/restore — restore a previous value from the backup ring.
 *   - GET  /admin/menu               — the captured wp-admin menu snapshot.
 *   - POST /admin/token              — a single-use token to fetch one wp-admin URL as admin.
 *
 * The admin token is how a front-end request to /wp-admin/<path>?wpxmcp_admin=<token>
 * is authenticated as the issuing administrator for that one request only. No
 * Set-Cookie ever reaches the client, and the wp-admin session used is torn down
 * at shutdown. Requests without a valid token behave exactly as before.
 *
 * @package wpxmcp
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Operating installed plugins as an administrator: settings, admin screens and their forms.
 */
class WPXMCP_Admin {

	/**
	 * Option or array keys whose values are credentials, masked unless revealed.
	 */
	const SECRET_KEY_PATTERN = '/(pass|secret|token|api[_-]?key|license|private[_-]?key|client[_-]?secret|auth[_-]?key)/i';

	/** Query-string parameter carrying an admin-fetch token. */
	const PARAM = 'wpxmcp_admin';

	/** Seconds an admin-fetch token stays valid before it is used. */
	const TOKEN_TTL = 120;

	/** Seconds the captured admin-menu snapshot is trusted. */
	const MENU_TTL = 600;

	/** Outstanding (unused, unexpired) admin-fetch tokens one user may hold. */
	const MAX_OUTSTANDING = 20;

	/** Number of previous option values kept per option. */
	const BACKUP_KEEP = 5;

	/**
	 * Singleton.
	 *
	 * @var WPXMCP_Admin|null
	 */
	private static $instance = null;

	/**
	 * The user this request has been authenticated as via a token, or 0.
	 *
	 * @var int
	 */
	private $acting_user = 0;

	/**
	 * The wp-admin session token in use for this authenticated request.
	 *
	 * @var string
	 */
	private $session_token = '';

	/**
	 * Accessor.
	 *
	 * @return WPXMCP_Admin
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

		// The only work an ordinary front-end request does: a single isset() check.
		if ( isset( $_GET[ self::PARAM ] ) && is_string( $_GET[ self::PARAM ] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			$this->maybe_authenticate( sanitize_text_field( wp_unslash( $_GET[ self::PARAM ] ) ) ); // phpcs:ignore WordPress.Security.NonceVerification.Recommended
		}
	}

	/* --------------------------------------------------------------------- */
	/* REST routes                                                           */
	/* --------------------------------------------------------------------- */

	/**
	 * Routes. Every one requires an administrator.
	 */
	public function register_routes() {
		$ns    = WPXMCP_NAMESPACE;
		$admin = array( WPXMCP_REST::instance(), 'require_admin' );

		register_rest_route( $ns, '/plugins/inspect', array(
			'methods'             => WP_REST_Server::READABLE,
			'callback'            => array( $this, 'rest_inspect' ),
			'permission_callback' => $admin,
		) );

		register_rest_route( $ns, '/plugins/settings', array(
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( $this, 'rest_get_settings' ),
				'permission_callback' => $admin,
			),
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( $this, 'rest_update_settings' ),
				'permission_callback' => $admin,
			),
		) );

		register_rest_route( $ns, '/plugins/settings/restore', array(
			'methods'             => WP_REST_Server::CREATABLE,
			'callback'            => array( $this, 'rest_restore_settings' ),
			'permission_callback' => $admin,
		) );

		register_rest_route( $ns, '/admin/menu', array(
			'methods'             => WP_REST_Server::READABLE,
			'callback'            => array( $this, 'rest_menu' ),
			'permission_callback' => $admin,
		) );

		register_rest_route( $ns, '/admin/allowed-options', array(
			'methods'             => WP_REST_Server::READABLE,
			'callback'            => array( $this, 'rest_allowed_options' ),
			'permission_callback' => $admin,
		) );

		register_rest_route( $ns, '/admin/token', array(
			'methods'             => WP_REST_Server::CREATABLE,
			'callback'            => array( $this, 'rest_create_token' ),
			'permission_callback' => $admin,
		) );
	}

	/* --------------------------------------------------------------------- */
	/* Plugin resolution                                                     */
	/* --------------------------------------------------------------------- */

	/**
	 * Resolve a caller-supplied identifier (slug, "dir/file", or Name) to a plugin.
	 *
	 * @param string $input Identifier.
	 * @return array|WP_Error [ file, dir, slug, textdomain, data, active ]
	 */
	private function resolve_plugin( $input ) {
		$input = trim( (string) $input );
		if ( '' === $input ) {
			return new WP_Error( 'wpxmcp_bad_plugin', 'A plugin identifier is required.', array( 'status' => 400 ) );
		}
		if ( ! function_exists( 'get_plugins' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}
		$all      = get_plugins();
		$needle   = strtolower( $input );
		$file     = '';

		// 1. Exact "dir/file.php".
		if ( isset( $all[ $input ] ) ) {
			$file = $input;
		}
		// 2. Slug (directory name), e.g. "wordpress-seo".
		if ( '' === $file ) {
			foreach ( $all as $plugin_file => $data ) {
				$dir = strtok( $plugin_file, '/' );
				if ( strtolower( (string) $dir ) === $needle ) {
					$file = $plugin_file;
					break;
				}
			}
		}
		// 3. Single-file plugin basename, e.g. "hello.php".
		if ( '' === $file && isset( $all[ $input ] ) ) {
			$file = $input;
		}
		if ( '' === $file ) {
			foreach ( $all as $plugin_file => $data ) {
				if ( strtolower( basename( $plugin_file ) ) === $needle ) {
					$file = $plugin_file;
					break;
				}
			}
		}
		// 4. Display name or text domain.
		if ( '' === $file ) {
			foreach ( $all as $plugin_file => $data ) {
				if ( strtolower( (string) $data['Name'] ) === $needle
					|| ( ! empty( $data['TextDomain'] ) && strtolower( (string) $data['TextDomain'] ) === $needle ) ) {
					$file = $plugin_file;
					break;
				}
			}
		}
		// 5. Partial name match, last resort.
		if ( '' === $file ) {
			foreach ( $all as $plugin_file => $data ) {
				if ( false !== strpos( strtolower( (string) $data['Name'] ), $needle ) ) {
					$file = $plugin_file;
					break;
				}
			}
		}

		if ( '' === $file ) {
			return new WP_Error(
				'wpxmcp_plugin_not_found',
				sprintf( 'No installed plugin matches "%s". Use the slug, the "dir/file.php" path, or the exact name.', $input ),
				array( 'status' => 404 )
			);
		}

		$data       = $all[ $file ];
		$dir_name   = strtok( $file, '/' );
		$has_dir    = false !== strpos( $file, '/' );
		$slug       = $has_dir ? $dir_name : preg_replace( '/\.php$/', '', $file );
		$plugin_dir = $has_dir ? trailingslashit( WP_PLUGIN_DIR . '/' . $dir_name ) : trailingslashit( WP_PLUGIN_DIR );

		return array(
			'file'       => $file,
			'dir'        => $plugin_dir,
			'real_dir'   => $this->real_dir( $plugin_dir ),
			'single'     => ! $has_dir,
			'main_file'  => wp_normalize_path( WP_PLUGIN_DIR . '/' . $file ),
			'slug'       => $slug,
			'textdomain' => ! empty( $data['TextDomain'] ) ? $data['TextDomain'] : $slug,
			'data'       => $data,
			'active'     => is_plugin_active( $file ),
		);
	}

	/**
	 * Real (symlink-resolved, normalised, trailing-slashed) path of a directory.
	 *
	 * @param string $dir Directory.
	 * @return string
	 */
	private function real_dir( $dir ) {
		$real = realpath( $dir );
		if ( false === $real ) {
			return trailingslashit( wp_normalize_path( $dir ) );
		}
		return trailingslashit( wp_normalize_path( $real ) );
	}

	/**
	 * Candidate option-name prefixes a plugin is likely to own.
	 *
	 * Built from its slug and text domain, a small map of well-known prefixes that
	 * cannot be derived (Yoast stores "wpseo_*"), and the leading token of names
	 * found by reflection to belong to the plugin: its admin page slugs, shortcodes
	 * and REST namespaces.
	 *
	 * @param array $plugin Resolved plugin.
	 * @return array
	 */
	private function option_prefixes( $plugin ) {
		static $cache = array();
		if ( isset( $cache[ $plugin['file'] ] ) ) {
			return $cache[ $plugin['file'] ];
		}
		$known = array(
			'wordpress-seo'          => array( 'wpseo', 'yoast' ),
			'seo-by-rank-math'       => array( 'rank_math', 'rank-math' ),
			'all-in-one-seo-pack'    => array( 'aioseo' ),
			'the-seo-framework'      => array( 'autodescription', 'the_seo_framework' ),
			'woocommerce'            => array( 'woocommerce', 'wc_' ),
			'contact-form-7'         => array( 'wpcf7' ),
			'wpforms-lite'           => array( 'wpforms' ),
			'litespeed-cache'        => array( 'litespeed' ),
			'w3-total-cache'         => array( 'w3tc' ),
			'wp-super-cache'         => array( 'wpsupercache', 'wp_super_cache' ),
			'updraftplus'            => array( 'updraft' ),
			'google-site-kit'        => array( 'googlesitekit' ),
			'redirection'            => array( 'redirection' ),
		);
		$out = array();
		foreach ( array( $plugin['slug'], $plugin['textdomain'] ) as $c ) {
			$c = strtolower( (string) $c );
			if ( '' === $c ) {
				continue;
			}
			$out[] = $c;
			$out[] = str_replace( '-', '_', $c );
		}
		if ( isset( $known[ $plugin['slug'] ] ) ) {
			$out = array_merge( $out, $known[ $plugin['slug'] ] );
		}
		// Names reflection attributes to this plugin.
		$names = array();
		foreach ( $this->menu_snapshot()['pages'] as $page ) {
			if ( ! empty( $page['plugin'] ) && $page['plugin'] === $plugin['slug'] ) {
				$names[] = $page['slug'];
			}
		}
		$names = array_merge( $names, $this->plugin_shortcodes( $plugin ) );
		$rest  = $this->plugin_rest_routes( $plugin );
		$names = array_merge( $names, $rest['namespaces'] );
		$stop  = array( 'admin', 'edit', 'options', 'settings', 'page', 'post', 'posts', 'tools', 'index', 'users', 'plugins', 'themes', 'upload', 'general', 'site', 'wp', 'wordpress' );
		foreach ( $names as $n ) {
			$token = strtolower( (string) preg_split( '#[_\-/.?=]#', (string) $n )[0] );
			if ( strlen( $token ) >= 4 && ! in_array( $token, $stop, true ) ) {
				$out[] = $token;
			}
		}
		$out = array_values( array_unique( array_filter( $out ) ) );
		$cache[ $plugin['file'] ] = $out;
		return $out;
	}

	/**
	 * Whether an option name is attributable to a plugin: registered under its
	 * settings, or matching one of its likely prefixes.
	 *
	 * @param string $option Option name.
	 * @param array  $plugin Resolved plugin.
	 * @return bool
	 */
	private function plugin_owns_option( $option, $plugin ) {
		$option = strtolower( trim( (string) $option ) );
		if ( '' === $option ) {
			return false;
		}
		$owned = $this->registered_option_names( $plugin );
		if ( in_array( $option, array_map( 'strtolower', $owned ), true ) ) {
			return true;
		}
		foreach ( $this->option_prefixes( $plugin ) as $prefix ) {
			if ( 0 === strpos( $option, $prefix ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Option names registered through the Settings API that belong to the plugin:
	 * its sanitize callback is defined in the plugin's files, or the option or its
	 * group matches the plugin's prefixes. Settings registered only on admin_init
	 * are invisible to REST, so the snapshot captured on the last admin request is
	 * merged in.
	 *
	 * @param array $plugin Resolved plugin.
	 * @return array
	 */
	private function registered_option_names( $plugin ) {
		$names    = array();
		$prefixes = $this->option_prefixes( $plugin );
		$entries  = array();

		if ( function_exists( 'get_registered_settings' ) ) {
			foreach ( (array) get_registered_settings() as $name => $args ) {
				$file              = ! empty( $args['sanitize_callback'] ) ? $this->callable_file( $args['sanitize_callback'] ) : '';
				$entries[ $name ]  = array(
					'group'  => isset( $args['group'] ) ? (string) $args['group'] : '',
					'plugin' => '' !== $file && $this->file_in_plugin( $file, $plugin ) ? $plugin['slug'] : null,
				);
			}
		}
		foreach ( $this->menu_snapshot()['settings'] as $row ) {
			if ( ! isset( $entries[ $row['option_name'] ] ) || empty( $entries[ $row['option_name'] ]['plugin'] ) ) {
				$entries[ $row['option_name'] ] = array( 'group' => (string) $row['group'], 'plugin' => $row['plugin'] );
			}
		}
		foreach ( $entries as $name => $e ) {
			if ( $e['plugin'] === $plugin['slug'] ) {
				$names[] = $name;
				continue;
			}
			$low   = strtolower( (string) $name );
			$group = strtolower( $e['group'] );
			foreach ( $prefixes as $prefix ) {
				if ( 0 === strpos( $low, $prefix ) || ( '' !== $group && 0 === strpos( $group, $prefix ) ) ) {
					$names[] = $name;
					break;
				}
			}
		}
		return array_values( array_unique( $names ) );
	}

	/* --------------------------------------------------------------------- */
	/* Reflection helpers                                                    */
	/* --------------------------------------------------------------------- */

	/**
	 * The file a callable is defined in, or ''.
	 *
	 * @param mixed $callable Callable.
	 * @return string
	 */
	private function callable_file( $callable ) {
		try {
			if ( is_string( $callable ) && false !== strpos( $callable, '::' ) ) {
				$parts    = explode( '::', $callable );
				$ref      = new ReflectionMethod( $parts[0], $parts[1] );
				$filename = $ref->getFileName();
			} elseif ( is_array( $callable ) && count( $callable ) === 2 ) {
				$ref      = new ReflectionMethod( is_object( $callable[0] ) ? get_class( $callable[0] ) : $callable[0], $callable[1] );
				$filename = $ref->getFileName();
			} elseif ( is_object( $callable ) && ! ( $callable instanceof Closure ) ) {
				$ref      = new ReflectionMethod( get_class( $callable ), '__invoke' );
				$filename = $ref->getFileName();
			} elseif ( is_string( $callable ) && function_exists( $callable ) ) {
				$ref      = new ReflectionFunction( $callable );
				$filename = $ref->getFileName();
			} elseif ( $callable instanceof Closure ) {
				$ref      = new ReflectionFunction( $callable );
				$filename = $ref->getFileName();
			} else {
				return '';
			}
			return $filename ? wp_normalize_path( $filename ) : '';
		} catch ( ReflectionException $e ) {
			return '';
		} catch ( Exception $e ) {
			return '';
		}
	}

	/**
	 * Whether a file lives inside a plugin's directory (symlinks resolved).
	 *
	 * @param string $file   Normalised absolute path.
	 * @param array  $plugin Resolved plugin.
	 * @return bool
	 */
	private function file_in_plugin( $file, $plugin ) {
		if ( '' === $file ) {
			return false;
		}
		$file = wp_normalize_path( $file );
		$real = realpath( $file );
		$real = false !== $real ? wp_normalize_path( $real ) : $file;
		if ( ! empty( $plugin['single'] ) ) {
			// A single-file plugin owns only its own file, never the whole plugins directory.
			return $file === $plugin['main_file'] || $real === $plugin['main_file'];
		}
		foreach ( array( $plugin['dir'], $plugin['real_dir'] ) as $root ) {
			$root = trailingslashit( wp_normalize_path( $root ) );
			if ( 0 === strpos( $file, $root ) || 0 === strpos( $real, $root ) ) {
				return true;
			}
		}
		return false;
	}

	/* --------------------------------------------------------------------- */
	/* inspect_plugin                                                        */
	/* --------------------------------------------------------------------- */

	/**
	 * Everything a plugin exposes and how to control it.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function rest_inspect( $request ) {
		$plugin = $this->resolve_plugin( (string) $request->get_param( 'plugin' ) );
		if ( is_wp_error( $plugin ) ) {
			return $plugin;
		}

		$data    = $plugin['data'];
		$rest    = $this->plugin_rest_routes( $plugin );
		$options = $this->plugin_options( $plugin );
		$menu    = $this->plugin_menu_pages( $plugin );

		$result = array(
			'plugin'    => array(
				'name'             => $data['Name'],
				'file'             => $plugin['file'],
				'slug'             => $plugin['slug'],
				'text_domain'      => $plugin['textdomain'],
				'version'          => $data['Version'],
				'active'           => $plugin['active'],
				'author'           => wp_strip_all_tags( (string) $data['Author'] ),
				'description'      => wp_strip_all_tags( (string) $data['Description'] ),
				'update_available' => $this->update_available( $plugin['file'] ),
			),
			'rest'              => $rest,
			'abilities'         => $this->plugin_abilities( $plugin ),
			'registered_settings' => $this->plugin_registered_settings( $plugin ),
			'options'           => $options,
			'admin_pages'       => $menu,
			'post_types'        => $this->plugin_post_types( $plugin ),
			'taxonomies'        => $this->plugin_taxonomies( $plugin ),
			'blocks'            => $this->plugin_blocks( $plugin ),
			'shortcodes'        => $this->plugin_shortcodes( $plugin ),
			'cron_events'       => $this->plugin_cron( $plugin ),
		);

		$snap                      = $this->menu_snapshot();
		$result['admin_snapshot']  = array( 'captured' => $snap['captured'], 'age_seconds' => $snap['age'] );
		$result['control_surface'] = $this->control_surface( $result, $plugin );
		return $result;
	}

	/**
	 * REST namespaces and routes whose callbacks are defined in the plugin's files.
	 *
	 * @param array $plugin Resolved plugin.
	 * @return array
	 */
	private function plugin_rest_routes( $plugin ) {
		$server = rest_get_server();
		$routes = $server->get_routes();
		$found  = array();
		$spaces = array();

		foreach ( $routes as $route => $handlers ) {
			$methods = array();
			$owned   = false;
			foreach ( $handlers as $handler ) {
				if ( empty( $handler['callback'] ) ) {
					continue;
				}
				$file = $this->callable_file( $handler['callback'] );
				if ( '' !== $file && $this->file_in_plugin( $file, $plugin ) ) {
					$owned = true;
					if ( isset( $handler['methods'] ) ) {
						foreach ( (array) $handler['methods'] as $m => $enabled ) {
							if ( $enabled ) {
								$methods[] = $m;
							}
						}
					}
				}
			}
			if ( $owned ) {
				$found[] = array(
					'route'   => $route,
					'methods' => array_values( array_unique( $methods ) ),
				);
				$ns = trim( $route, '/' );
				$ns = substr( $ns, 0, strrpos( $ns . '/', '/' ) );
				if ( '' !== $ns && substr_count( $route, '/' ) >= 2 ) {
					$parts    = explode( '/', trim( $route, '/' ) );
					$spaces[] = $parts[0] . '/' . ( isset( $parts[1] ) ? $parts[1] : '' );
				}
			}
		}

		return array(
			'namespaces' => array_values( array_unique( array_filter( $spaces ) ) ),
			'routes'     => $found,
		);
	}

	/**
	 * Abilities (Abilities API) registered from the plugin's files.
	 *
	 * @param array $plugin Resolved plugin.
	 * @return array
	 */
	private function plugin_abilities( $plugin ) {
		if ( ! function_exists( 'wp_get_abilities' ) ) {
			return array();
		}
		$out = array();
		foreach ( wp_get_abilities() as $ability ) {
			if ( ! is_object( $ability ) || ! method_exists( $ability, 'get_name' ) ) {
				continue;
			}
			$name  = $ability->get_name();
			$ns    = strtok( (string) $name, '/' );
			$match = false;
			foreach ( $this->option_prefixes( $plugin ) as $prefix ) {
				if ( 0 === strpos( strtolower( (string) $ns ), $prefix ) ) {
					$match = true;
					break;
				}
			}
			if ( $match ) {
				$out[] = array(
					'name'        => $name,
					'label'       => method_exists( $ability, 'get_label' ) ? $ability->get_label() : '',
					'description' => method_exists( $ability, 'get_description' ) ? wp_strip_all_tags( (string) $ability->get_description() ) : '',
				);
			}
		}
		return $out;
	}

	/**
	 * Registered Settings API entries owned by the plugin.
	 *
	 * @param array $plugin Resolved plugin.
	 * @return array
	 */
	private function plugin_registered_settings( $plugin ) {
		$live = function_exists( 'get_registered_settings' ) ? get_registered_settings() : array();
		$snap = array();
		foreach ( $this->menu_snapshot()['settings'] as $row ) {
			$snap[ $row['option_name'] ] = $row;
		}
		$out = array();
		foreach ( $this->registered_option_names( $plugin ) as $name ) {
			$args  = isset( $live[ $name ] ) ? $live[ $name ] : ( isset( $snap[ $name ] ) ? $snap[ $name ] : array() );
			$out[] = array(
				'option_name'  => $name,
				'group'        => isset( $args['group'] ) ? $args['group'] : null,
				'type'         => isset( $args['type'] ) ? $args['type'] : null,
				'show_in_rest' => ! empty( $args['show_in_rest'] ),
				'registered_in' => isset( $live[ $name ] ) ? 'every request' : 'wp-admin only',
			);
		}
		return $out;
	}

	/**
	 * Options the plugin likely owns, by prefix match, with size and autoload.
	 *
	 * @param array $plugin Resolved plugin.
	 * @return array
	 */
	private function plugin_options( $plugin ) {
		global $wpdb;
		$prefixes = $this->option_prefixes( $plugin );
		if ( empty( $prefixes ) ) {
			return array();
		}
		$likes = array();
		$args  = array();
		foreach ( $prefixes as $prefix ) {
			$likes[] = 'option_name LIKE %s';
			$args[]  = $wpdb->esc_like( $prefix ) . '%';
		}
		// Also the exact registered option names.
		foreach ( $this->registered_option_names( $plugin ) as $name ) {
			$likes[] = 'option_name = %s';
			$args[]  = $name;
		}
		$sql  = "SELECT option_name, LENGTH(option_value) AS bytes, autoload FROM {$wpdb->options} WHERE " . implode( ' OR ', $likes ) . ' ORDER BY bytes DESC LIMIT 100';
		$rows = $wpdb->get_results( $wpdb->prepare( $sql, $args ), ARRAY_A ); // phpcs:ignore WordPress.DB
		$out  = array();
		foreach ( (array) $rows as $row ) {
			$out[] = array(
				'option_name' => $row['option_name'],
				'bytes'       => (int) $row['bytes'],
				'autoload'    => $row['autoload'],
			);
		}
		return $out;
	}

	/**
	 * Admin menu pages the plugin adds, from the captured menu snapshot.
	 *
	 * @param array $plugin Resolved plugin.
	 * @return array
	 */
	private function plugin_menu_pages( $plugin ) {
		$snapshot = $this->menu_snapshot();
		$out      = array();
		foreach ( $snapshot['pages'] as $page ) {
			if ( $this->menu_page_belongs( $page, $plugin ) ) {
				$out[] = $page;
			}
		}
		return $out;
	}

	/**
	 * Whether a captured menu page belongs to the plugin: attributed by reflecting
	 * its page callback, or failing that by slug prefix.
	 *
	 * @param array $page   Menu page.
	 * @param array $plugin Resolved plugin.
	 * @return bool
	 */
	private function menu_page_belongs( $page, $plugin ) {
		if ( ! empty( $page['plugin'] ) ) {
			return $page['plugin'] === $plugin['slug'];
		}
		if ( false !== strpos( (string) $page['slug'], '.php' ) ) {
			return false; // Core screens (edit.php?post_type=…) are not attributed by prefix.
		}
		$slug = strtolower( (string) $page['slug'] );
		foreach ( $this->option_prefixes( $plugin ) as $prefix ) {
			if ( 0 === strpos( $slug, $prefix ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Non-builtin post types attributable to the plugin.
	 *
	 * @param array $plugin Resolved plugin.
	 * @return array
	 */
	private function plugin_post_types( $plugin ) {
		$out = array();
		foreach ( get_post_types( array( '_builtin' => false ), 'objects' ) as $pt ) {
			foreach ( $this->option_prefixes( $plugin ) as $prefix ) {
				if ( 0 === strpos( strtolower( (string) $pt->name ), $prefix ) ) {
					$out[] = array( 'name' => $pt->name, 'label' => $pt->label, 'show_in_rest' => ! empty( $pt->show_in_rest ), 'rest_base' => $pt->rest_base ? $pt->rest_base : $pt->name );
					break;
				}
			}
		}
		return $out;
	}

	/**
	 * Non-builtin taxonomies attributable to the plugin.
	 *
	 * @param array $plugin Resolved plugin.
	 * @return array
	 */
	private function plugin_taxonomies( $plugin ) {
		$out = array();
		foreach ( get_taxonomies( array( '_builtin' => false ), 'objects' ) as $tax ) {
			foreach ( $this->option_prefixes( $plugin ) as $prefix ) {
				if ( 0 === strpos( strtolower( (string) $tax->name ), $prefix ) ) {
					$out[] = array( 'name' => $tax->name, 'label' => $tax->label );
					break;
				}
			}
		}
		return $out;
	}

	/**
	 * Blocks registered from the plugin's files.
	 *
	 * @param array $plugin Resolved plugin.
	 * @return array
	 */
	private function plugin_blocks( $plugin ) {
		if ( ! class_exists( 'WP_Block_Type_Registry' ) ) {
			return array();
		}
		$out = array();
		foreach ( WP_Block_Type_Registry::get_instance()->get_all_registered() as $name => $block ) {
			foreach ( $this->option_prefixes( $plugin ) as $prefix ) {
				if ( 0 === strpos( strtolower( (string) $name ), $prefix ) ) {
					$out[] = $name;
					break;
				}
			}
		}
		return array_values( array_unique( $out ) );
	}

	/**
	 * Shortcodes whose callback is defined in the plugin's files.
	 *
	 * @param array $plugin Resolved plugin.
	 * @return array
	 */
	private function plugin_shortcodes( $plugin ) {
		global $shortcode_tags;
		$out = array();
		if ( ! is_array( $shortcode_tags ) ) {
			return $out;
		}
		foreach ( $shortcode_tags as $tag => $cb ) {
			$file = $this->callable_file( $cb );
			if ( '' !== $file && $this->file_in_plugin( $file, $plugin ) ) {
				$out[] = $tag;
			}
		}
		return $out;
	}

	/**
	 * Cron hooks the plugin has scheduled (by prefix match on the hook name).
	 *
	 * @param array $plugin Resolved plugin.
	 * @return array
	 */
	private function plugin_cron( $plugin ) {
		$crons = _get_cron_array();
		if ( ! is_array( $crons ) ) {
			return array();
		}
		$hooks = array();
		foreach ( $crons as $events ) {
			foreach ( (array) $events as $hook => $_ ) {
				foreach ( $this->option_prefixes( $plugin ) as $prefix ) {
					if ( 0 === strpos( strtolower( (string) $hook ), $prefix ) ) {
						$hooks[] = $hook;
						break;
					}
				}
			}
		}
		return array_values( array_unique( $hooks ) );
	}

	/**
	 * Whether an update is available for the plugin.
	 *
	 * @param string $file Plugin file.
	 * @return bool
	 */
	private function update_available( $file ) {
		$updates = get_site_transient( 'update_plugins' );
		return isset( $updates->response[ $file ] );
	}

	/**
	 * A per-task recommendation of the best control path.
	 *
	 * @param array $result Assembled inspection.
	 * @param array $plugin Resolved plugin.
	 * @return array
	 */
	private function control_surface( $result, $plugin ) {
		$recommend = array();
		if ( ! empty( $result['abilities'] ) ) {
			$recommend[] = 'run_ability — the plugin registers Abilities API abilities; prefer these, the plugin\'s own validation and hooks run.';
		}
		if ( ! empty( $result['rest']['routes'] ) ) {
			$recommend[] = 'rest_api / discover_rest_routes — the plugin exposes its own REST routes (see rest.routes); use them for a stable, structured path.';
		}
		$admin_only = array();
		foreach ( $result['registered_settings'] as $setting ) {
			if ( 'wp-admin only' === $setting['registered_in'] ) {
				$admin_only[] = $setting['option_name'];
			}
		}
		if ( ! empty( $admin_only ) && ! empty( $result['admin_pages'] ) ) {
			$recommend[] = 'admin_page + submit_admin_form — ' . implode( ', ', array_slice( $admin_only, 0, 5 ) ) . ' are registered only in wp-admin, so their sanitize callbacks run only on a wp-admin save; change them through the plugin\'s own settings form. update_plugin_settings would write them unsanitized.';
		}
		if ( ! empty( $result['registered_settings'] ) && count( $admin_only ) < count( $result['registered_settings'] ) ) {
			$recommend[] = 'update_plugin_settings — some options are registered on every request, so writing them runs the plugin\'s sanitize callbacks like a wp-admin save.';
		} elseif ( ! empty( $result['options'] ) ) {
			$recommend[] = 'get_plugin_settings / update_plugin_settings — the plugin stores configuration in options (see options); read them, then write with update_plugin_settings.';
		}
		if ( ! empty( $result['admin_pages'] ) ) {
			$recommend[] = 'admin_page + submit_admin_form — the plugin adds wp-admin screens (see admin_pages); for settings that only exist on those forms, view the screen and submit the form.';
		}
		if ( empty( $recommend ) ) {
			$recommend[] = 'No structured surface was detected. Try admin_page on the plugin\'s screen, or run_wp_cli if it ships a CLI command.';
		}
		return array(
			'best_path' => $recommend[0],
			'options'   => $recommend,
		);
	}

	/* --------------------------------------------------------------------- */
	/* Settings read / write / restore                                       */
	/* --------------------------------------------------------------------- */

	/**
	 * Read an owned option, unserialised, with obvious secrets redacted.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function rest_get_settings( $request ) {
		$plugin = $this->resolve_plugin( (string) $request->get_param( 'plugin' ) );
		if ( is_wp_error( $plugin ) ) {
			return $plugin;
		}
		$option = trim( (string) $request->get_param( 'option' ) );
		$reveal = (bool) rest_sanitize_boolean( $request->get_param( 'reveal' ) );

		if ( '' === $option ) {
			return array(
				'plugin'  => $plugin['slug'],
				'options' => $this->plugin_options( $plugin ),
				'note'    => 'Pass an option name to read its value.',
			);
		}

		$sentinel = '__wpxmcp_absent__';
		$value    = get_option( $option, $sentinel );
		if ( $sentinel === $value ) {
			return new WP_Error( 'wpxmcp_option_absent', sprintf( 'The option "%s" does not exist.', $option ), array( 'status' => 404 ) );
		}

		return array(
			'plugin'    => $plugin['slug'],
			'option'    => $option,
			'owned'     => $this->plugin_owns_option( $option, $plugin ),
			'redacted'  => ! $reveal,
			'value'     => $reveal ? $value : $this->redact( $value, $option ),
		);
	}

	/**
	 * Write an owned option through update_option(), so its sanitize callbacks run.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function rest_update_settings( $request ) {
		$plugin = $this->resolve_plugin( (string) $request->get_param( 'plugin' ) );
		if ( is_wp_error( $plugin ) ) {
			return $plugin;
		}
		$option = trim( (string) $request->get_param( 'option' ) );
		if ( '' === $option ) {
			return new WP_Error( 'wpxmcp_bad_option', 'An option name is required.', array( 'status' => 400 ) );
		}
		if ( wpxmcp_is_protected_option( $option ) ) {
			return new WP_Error( 'wpxmcp_protected_option', sprintf( 'The option "%s" is protected and cannot be written through this route.', $option ), array( 'status' => 400 ) );
		}
		$force = (bool) rest_sanitize_boolean( $request->get_param( 'force_option' ) );
		if ( ! $force && ! $this->plugin_owns_option( $option, $plugin ) ) {
			return new WP_Error(
				'wpxmcp_option_not_owned',
				sprintf( 'The option "%s" is not attributable to "%s". Pass force_option to write it anyway.', $option, $plugin['slug'] ),
				array( 'status' => 400 )
			);
		}

		$sentinel = '__wpxmcp_absent__';
		$previous = get_option( $option, $sentinel );
		$had      = $sentinel !== $previous;

		$changes    = $request->get_param( 'changes' );
		$has_value  = null !== $request->get_param( 'value' );
		if ( $has_value ) {
			$new = $request->get_param( 'value' );
		} elseif ( null !== $changes ) {
			$base = ( $had && is_array( $previous ) ) ? $previous : array();
			if ( ! is_array( $changes ) ) {
				return new WP_Error( 'wpxmcp_bad_changes', 'changes must be an object to deep-merge into the option.', array( 'status' => 400 ) );
			}
			$new = $this->deep_merge( $base, $changes );
		} else {
			return new WP_Error( 'wpxmcp_nothing_to_write', 'Pass either "value" (replace) or "changes" (deep-merge).', array( 'status' => 400 ) );
		}

		if ( $had ) {
			$this->push_backup( $option, $previous );
		}

		// Whether a sanitize callback is attached in this (REST) request. Plugins that
		// call register_setting() only on admin_init have none here.
		$filter = (bool) has_filter( 'sanitize_option_' . $option );
		$ok     = update_option( $option, $new );
		// update_option returns false when the sanitised value is unchanged; not an error.
		wp_cache_delete( $option, 'options' );
		$after = get_option( $option, $sentinel );

		wpxmcp_audit( 'plugin_settings.update', array( 'plugin' => $plugin['slug'], 'option' => $option ) );

		return array(
			'updated'       => true,
			'changed'       => (bool) $ok,
			'option'        => $option,
			'sanitize_filter_ran' => $filter,
			'sanitizer_adjusted'  => $this->diff_paths( $new, $after ),
			'previous'      => $had ? $this->redact( $previous, $option ) : null,
			'value_after_sanitize' => $this->redact( $after, $option ),
			'backup_available' => $had,
			'undo'          => $had ? sprintf( 'restore_plugin_settings with option "%s" restores the value from before this write.', $option ) : null,
		);
	}

	/**
	 * Paths where the stored value differs from what was requested (changed or dropped by a sanitizer).
	 *
	 * @param mixed  $requested Requested value.
	 * @param mixed  $stored    Stored value.
	 * @param string $prefix    Path prefix.
	 * @return array
	 */
	private function diff_paths( $requested, $stored, $prefix = '' ) {
		$out = array();
		if ( is_array( $requested ) && is_array( $stored ) ) {
			foreach ( $requested as $k => $v ) {
				$path = '' === $prefix ? (string) $k : $prefix . '.' . $k;
				if ( ! array_key_exists( $k, $stored ) ) {
					$out[] = array( 'path' => $path, 'change' => 'dropped' );
				} else {
					$out = array_merge( $out, $this->diff_paths( $v, $stored[ $k ], $path ) );
				}
				if ( count( $out ) >= 50 ) {
					break;
				}
			}
			return $out;
		}
		if ( ( is_scalar( $requested ) || null === $requested ) && ( is_scalar( $stored ) || null === $stored ) ) {
			// "1", 1 and true are the same setting to WordPress.
			$same = (string) $requested === (string) $stored || ( is_bool( $requested ) && (bool) $stored === $requested );
		} else {
			$same = wp_json_encode( $requested ) === wp_json_encode( $stored );
		}
		if ( ! $same ) {
			$out[] = array( 'path' => '' === $prefix ? '(value)' : $prefix, 'change' => 'changed' );
		}
		return $out;
	}

	/**
	 * Restore a previous option value from the backup ring.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function rest_restore_settings( $request ) {
		$option = trim( (string) $request->get_param( 'option' ) );
		if ( '' === $option ) {
			return new WP_Error( 'wpxmcp_bad_option', 'An option name is required.', array( 'status' => 400 ) );
		}
		if ( wpxmcp_is_protected_option( $option ) ) {
			return new WP_Error( 'wpxmcp_protected_option', 'That option is protected.', array( 'status' => 400 ) );
		}
		$backups = $this->get_backups( $option );
		if ( empty( $backups ) ) {
			return new WP_Error( 'wpxmcp_no_backup', sprintf( 'No backup of "%s" is stored.', $option ), array( 'status' => 404 ) );
		}
		$index = $request->get_param( 'backup_index' );
		$index = null === $index ? count( $backups ) - 1 : (int) $index;
		if ( ! isset( $backups[ $index ] ) ) {
			return new WP_Error( 'wpxmcp_bad_index', sprintf( 'backup_index %d is out of range (0..%d).', $index, count( $backups ) - 1 ), array( 'status' => 400 ) );
		}

		// A backup exists only because an update_plugin_settings write passed its
		// ownership and protection checks, so no separate ownership check is needed.
		$sentinel = '__wpxmcp_absent__';
		$current  = get_option( $option, $sentinel );
		if ( rest_sanitize_boolean( $request->get_param( 'dry_run' ) ) ) {
			return array(
				'dry_run'     => true,
				'option'      => $option,
				'index'       => $index,
				'backup_time' => isset( $backups[ $index ]['time'] ) ? $backups[ $index ]['time'] : null,
				'current'     => $sentinel === $current ? null : $this->redact( $current, $option ),
				'restore_to'  => $this->redact( $backups[ $index ]['value'], $option ),
				'fingerprint' => md5( maybe_serialize( array( $sentinel === $current ? null : $current, $backups[ $index ]['value'] ) ) ),
			);
		}

		// Back up the current value before overwriting it, so a restore is itself undoable.
		if ( $sentinel !== $current ) {
			$this->push_backup( $option, $current );
		}
		$restored = $backups[ $index ]['value'];
		update_option( $option, $restored );

		wpxmcp_audit( 'plugin_settings.restore', array( 'option' => $option, 'index' => $index ) );

		return array(
			'restored' => true,
			'option'   => $option,
			'index'    => $index,
			'value'    => $this->redact( get_option( $option, null ), $option ),
		);
	}

	/**
	 * Backup ring option key for an option.
	 *
	 * @param string $option Option name.
	 * @return string
	 */
	private function backup_key( $option ) {
		return 'wpxmcp_settings_backup_' . md5( $option );
	}

	/**
	 * Push a value onto the option's backup ring (kept non-autoloaded, last N).
	 *
	 * @param string $option Option name.
	 * @param mixed  $value  Value to store.
	 */
	private function push_backup( $option, $value ) {
		$key  = $this->backup_key( $option );
		$ring = get_option( $key, array() );
		if ( ! is_array( $ring ) ) {
			$ring = array();
		}
		$ring[] = array( 'time' => gmdate( 'c' ), 'value' => $value );
		if ( count( $ring ) > self::BACKUP_KEEP ) {
			$ring = array_slice( $ring, -self::BACKUP_KEEP );
		}
		update_option( $key, $ring, false );
	}

	/**
	 * The backup ring for an option.
	 *
	 * @param string $option Option name.
	 * @return array
	 */
	private function get_backups( $option ) {
		$ring = get_option( $this->backup_key( $option ), array() );
		return is_array( $ring ) ? array_values( $ring ) : array();
	}

	/**
	 * Deep-merge $changes into $base (associative arrays merge, everything else replaces).
	 *
	 * @param mixed $base    Base value.
	 * @param mixed $changes Changes.
	 * @return mixed
	 */
	private function deep_merge( $base, $changes ) {
		if ( ! is_array( $base ) || ! is_array( $changes ) ) {
			return $changes;
		}
		// A list (sequential keys) replaces wholesale — merging arrays of items by index is rarely intended.
		if ( $this->is_list( $changes ) ) {
			return $changes;
		}
		foreach ( $changes as $k => $v ) {
			if ( isset( $base[ $k ] ) && is_array( $base[ $k ] ) && is_array( $v ) && ! $this->is_list( $v ) ) {
				$base[ $k ] = $this->deep_merge( $base[ $k ], $v );
			} else {
				$base[ $k ] = $v;
			}
		}
		return $base;
	}

	/**
	 * Whether an array is a sequential list (0..n-1 integer keys).
	 *
	 * @param array $arr Array.
	 * @return bool
	 */
	private function is_list( $arr ) {
		if ( ! is_array( $arr ) ) {
			return false;
		}
		$i = 0;
		foreach ( $arr as $k => $_ ) {
			if ( $k !== $i ) {
				return false;
			}
			$i++;
		}
		return true;
	}

	/**
	 * Recursively redact values under keys that look like secrets.
	 *
	 * @param mixed $value Value.
	 * @param string $name  Option name; a secret-looking name masks a scalar value.
	 * @return mixed
	 */
	private function redact( $value, $name = '' ) {
		if ( '' !== $name && ( is_string( $value ) || is_numeric( $value ) ) && preg_match( self::SECRET_KEY_PATTERN, (string) $name ) ) {
			return $this->mask( (string) $value );
		}
		if ( is_array( $value ) ) {
			$out = array();
			foreach ( $value as $k => $v ) {
				if ( is_string( $k ) && preg_match( self::SECRET_KEY_PATTERN, $k ) && ( is_string( $v ) || is_numeric( $v ) ) ) {
					$out[ $k ] = $this->mask( (string) $v );
				} else {
					$out[ $k ] = $this->redact( $v );
				}
			}
			return $out;
		}
		if ( is_object( $value ) ) {
			$clone = clone $value;
			foreach ( get_object_vars( $clone ) as $k => $v ) {
				if ( preg_match( self::SECRET_KEY_PATTERN, (string) $k ) && ( is_string( $v ) || is_numeric( $v ) ) ) {
					$clone->$k = $this->mask( (string) $v );
				} else {
					$clone->$k = $this->redact( $v );
				}
			}
			return $clone;
		}
		return $value;
	}

	/**
	 * Mask a secret, keeping the last four characters.
	 *
	 * @param string $s Secret.
	 * @return string
	 */
	private function mask( $s ) {
		if ( '' === $s ) {
			return $s;
		}
		$tail = strlen( $s ) > 4 ? substr( $s, -4 ) : '';
		return '••••' . $tail;
	}

	/* --------------------------------------------------------------------- */
	/* Admin menu snapshot                                                   */
	/* --------------------------------------------------------------------- */

	/**
	 * Return the captured admin-menu snapshot for the REST caller.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array
	 */
	public function rest_menu( $request ) {
		$plugin_param = trim( (string) $request->get_param( 'plugin' ) );
		$snapshot     = $this->menu_snapshot();
		if ( '' === $plugin_param ) {
			return $snapshot;
		}
		$plugin = $this->resolve_plugin( $plugin_param );
		if ( is_wp_error( $plugin ) ) {
			return $plugin;
		}
		$pages = array();
		foreach ( $snapshot['pages'] as $page ) {
			if ( $this->menu_page_belongs( $page, $plugin ) ) {
				$pages[] = $page;
			}
		}
		return array( 'captured' => $snapshot['captured'], 'age' => $snapshot['age'], 'pages' => $pages );
	}

	/**
	 * The stored admin snapshot (menu pages and admin-only registered settings), or
	 * an empty one when none exists or the active plugins changed since capture.
	 *
	 * @return array
	 */
	private function menu_snapshot() {
		$stored = get_transient( 'wpxmcp_admin_menu' );
		$empty  = array( 'captured' => false, 'age' => null, 'pages' => array(), 'settings' => array() );
		if ( ! is_array( $stored ) || empty( $stored['pages'] ) ) {
			return $empty;
		}
		if ( ! isset( $stored['plugins_hash'] ) || $stored['plugins_hash'] !== $this->active_plugins_hash() ) {
			return $empty;
		}
		return array(
			'captured' => true,
			'age'      => time() - (int) $stored['time'],
			'pages'    => $stored['pages'],
			'settings' => isset( $stored['settings'] ) ? $stored['settings'] : array(),
		);
	}

	/**
	 * Hash of the active plugin list, so a snapshot goes stale when it changes.
	 *
	 * @return string
	 */
	private function active_plugins_hash() {
		$active = (array) get_option( 'active_plugins', array() );
		if ( is_multisite() ) {
			$active = array_merge( $active, array_keys( (array) get_site_option( 'active_sitewide_plugins', array() ) ) );
		}
		sort( $active );
		return md5( (string) wp_json_encode( $active ) );
	}

	/**
	 * Snapshot the built admin menu and the Settings API registrations into a
	 * transient. Runs on an authenticated tokenised admin request at admin_init
	 * (PHP_INT_MAX), after menu.php has built and filtered $menu/$submenu and after
	 * plugins have called register_setting().
	 */
	public function capture_menu() {
		global $menu, $submenu;
		if ( ! is_array( $menu ) ) {
			return;
		}
		$pages = array();
		foreach ( $menu as $item ) {
			if ( empty( $item[2] ) ) {
				continue;
			}
			$slug    = (string) $item[2];
			$pages[] = array(
				'title'      => $this->clean_menu_title( isset( $item[0] ) ? (string) $item[0] : '' ),
				'slug'       => $slug,
				'url'        => $this->menu_url( $slug, '' ),
				'parent'     => null,
				'capability' => isset( $item[1] ) ? (string) $item[1] : '',
				'plugin'     => $this->page_owner( $slug, '' ),
			);
			if ( isset( $submenu[ $slug ] ) && is_array( $submenu[ $slug ] ) ) {
				foreach ( $submenu[ $slug ] as $sub ) {
					if ( empty( $sub[2] ) ) {
						continue;
					}
					$sub_slug = (string) $sub[2];
					$pages[]  = array(
						'title'      => $this->clean_menu_title( isset( $sub[0] ) ? (string) $sub[0] : '' ),
						'slug'       => $sub_slug,
						'url'        => $this->menu_url( $sub_slug, $slug ),
						'parent'     => $slug,
						'capability' => isset( $sub[1] ) ? (string) $sub[1] : '',
						'plugin'     => $this->page_owner( $sub_slug, $slug ),
					);
				}
			}
		}

		$settings = array();
		if ( function_exists( 'get_registered_settings' ) ) {
			foreach ( (array) get_registered_settings() as $name => $args ) {
				$file       = ! empty( $args['sanitize_callback'] ) ? $this->callable_file( $args['sanitize_callback'] ) : '';
				$settings[] = array(
					'option_name'  => (string) $name,
					'group'        => isset( $args['group'] ) ? (string) $args['group'] : '',
					'type'         => isset( $args['type'] ) ? (string) $args['type'] : '',
					'show_in_rest' => ! empty( $args['show_in_rest'] ),
					'plugin'       => '' !== $file ? $this->plugin_slug_for_file( $file ) : null,
				);
			}
		}

		set_transient( 'wpxmcp_admin_menu', array(
			'time'         => time(),
			'plugins_hash' => $this->active_plugins_hash(),
			'pages'        => $pages,
			'settings'     => $settings,
		), self::MENU_TTL );
	}

	/**
	 * Strip the notification bubble markup WordPress appends to some menu titles.
	 *
	 * @param string $title Title.
	 * @return string
	 */
	private function clean_menu_title( $title ) {
		// Count bubbles (<span class="update-plugins count-3">…</span>) and their screen-reader text.
		$title = preg_replace( '#<span[^>]*class=["\'][^"\']*(update-plugins|awaiting-mod|menu-counter|count-\d+|screen-reader-text|issue-counter)[^"\']*["\'][^>]*>.*?</span>(\s*</span>)*#is', '', (string) $title );
		$title = html_entity_decode( wp_strip_all_tags( (string) $title ), ENT_QUOTES, 'UTF-8' );
		return trim( (string) preg_replace( '/\s+/', ' ', $title ) );
	}

	/**
	 * The admin URL for a menu slug: a full URL passes through, a *.php slug is a
	 * screen file, and a plain slug is a plugin page under its parent file.
	 *
	 * @param string $slug   Menu slug.
	 * @param string $parent Parent slug ('' for top level).
	 * @return string
	 */
	private function menu_url( $slug, $parent ) {
		if ( false !== strpos( $slug, '://' ) ) {
			return $slug;
		}
		if ( false !== strpos( $slug, '.php' ) ) {
			return admin_url( $slug );
		}
		if ( '' !== $parent && false !== strpos( $parent, '.php' ) && 0 !== strpos( $parent, 'admin.php' ) ) {
			return admin_url( add_query_arg( 'page', $slug, $parent ) );
		}
		return admin_url( 'admin.php?page=' . rawurlencode( $slug ) );
	}

	/**
	 * Which plugin renders a menu page: reflect the callbacks attached to its page
	 * hook (what add_menu_page/add_submenu_page register) back to a file.
	 *
	 * @param string $slug   Menu slug.
	 * @param string $parent Parent slug.
	 * @return string|null Plugin slug.
	 */
	private function page_owner( $slug, $parent ) {
		global $wp_filter;
		if ( false !== strpos( $slug, '://' ) || ! function_exists( 'get_plugin_page_hookname' ) ) {
			return null;
		}
		$hook = get_plugin_page_hookname( $slug, $parent );
		if ( ! isset( $wp_filter[ $hook ] ) ) {
			// Pages pointing at a plugin file ("my-plugin/admin.php") rather than a callback.
			if ( false !== strpos( $slug, '/' ) ) {
				return $this->plugin_slug_for_file( WP_PLUGIN_DIR . '/' . $slug );
			}
			return null;
		}
		foreach ( $wp_filter[ $hook ]->callbacks as $callbacks ) {
			foreach ( $callbacks as $cb ) {
				$file  = $this->callable_file( $cb['function'] );
				$owner = '' !== $file ? $this->plugin_slug_for_file( $file ) : null;
				if ( $owner ) {
					return $owner;
				}
			}
		}
		return null;
	}

	/**
	 * The plugin slug a file belongs to (symlinked plugin folders resolved), or null.
	 *
	 * @param string $file Absolute path.
	 * @return string|null
	 */
	private function plugin_slug_for_file( $file ) {
		static $roots = null;
		if ( null === $roots ) {
			$roots = array();
			$base  = trailingslashit( wp_normalize_path( WP_PLUGIN_DIR ) );
			foreach ( (array) glob( WP_PLUGIN_DIR . '/*', GLOB_ONLYDIR ) as $dir ) {
				$slug = basename( $dir );
				$roots[ $base . $slug . '/' ] = $slug;
				$real = realpath( $dir );
				if ( $real ) {
					$roots[ trailingslashit( wp_normalize_path( $real ) ) ] = $slug;
				}
			}
		}
		$f    = wp_normalize_path( $file );
		$real = realpath( $file );
		$real = $real ? wp_normalize_path( $real ) : $f;
		foreach ( $roots as $root => $slug ) {
			if ( 0 === strpos( $f, $root ) || 0 === strpos( $real, $root ) ) {
				return $slug;
			}
		}
		return null;
	}

	/* --------------------------------------------------------------------- */
	/* Admin-fetch tokens                                                    */
	/* --------------------------------------------------------------------- */

	/**
	 * Keyed hash of a token, so the raw token is never a storage key.
	 *
	 * @param string $token Token.
	 * @return string
	 */
	private function hash_token( $token ) {
		return substr( hash_hmac( 'sha256', (string) $token, wp_salt( 'nonce' ) ), 0, 40 );
	}

	/**
	 * Canonical wp-admin-relative path for a caller-supplied path or URL.
	 *
	 * "admin.php?page=x", "/wp-admin/admin.php", or a full admin URL all reduce
	 * to the script path relative to wp-admin, e.g. "admin.php".
	 *
	 * @param string $input Path or URL.
	 * @return string|WP_Error
	 */
	private function admin_relative_path( $input ) {
		$input = trim( (string) $input );
		if ( '' === $input ) {
			return new WP_Error( 'wpxmcp_bad_path', 'A wp-admin path is required.', array( 'status' => 400 ) );
		}
		$parts = wp_parse_url( $input );
		if ( false === $parts ) {
			return new WP_Error( 'wpxmcp_bad_path', 'The path could not be parsed.', array( 'status' => 400 ) );
		}
		$path = isset( $parts['path'] ) ? $parts['path'] : '';
		if ( '' === $path ) {
			// "admin.php?page=x" — no leading slash, wp_parse_url puts it in 'path' anyway,
			// but guard the pure-query case by treating the input's pre-? part as the path.
			$q    = strpos( $input, '?' );
			$path = false === $q ? $input : substr( $input, 0, $q );
		}
		// Reduce to the segment after the last "wp-admin/".
		$marker = 'wp-admin/';
		$pos    = strrpos( $path, $marker );
		if ( false !== $pos ) {
			$path = substr( $path, $pos + strlen( $marker ) );
		}
		$path = ltrim( $path, '/' );
		if ( '' === $path ) {
			$path = 'index.php';
		}
		// Only .php scripts inside wp-admin are addressable, no directory traversal.
		if ( false !== strpos( $path, '..' ) || ! preg_match( '#^[A-Za-z0-9_./-]+\.php$#', $path ) ) {
			return new WP_Error( 'wpxmcp_bad_path', sprintf( 'Only wp-admin PHP scripts can be fetched; "%s" is not one.', $input ), array( 'status' => 400 ) );
		}
		return $path;
	}

	/**
	 * Canonical query string (token and cache-buster removed, keys sorted).
	 *
	 * @param string $query Raw query.
	 * @return string
	 */
	private function normalise_query( $query ) {
		$args = array();
		wp_parse_str( (string) $query, $args );
		unset( $args[ self::PARAM ] );
		ksort( $args );
		return (string) wp_json_encode( $args );
	}

	/**
	 * Issue a single-use token bound to one wp-admin path + method.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public function rest_create_token( $request ) {
		$raw    = (string) $request->get_param( 'path' );
		$path   = $this->admin_relative_path( $raw );
		if ( is_wp_error( $path ) ) {
			return $path;
		}
		$method = strtoupper( trim( (string) $request->get_param( 'method' ) ) );
		if ( 'GET' !== $method && 'POST' !== $method ) {
			$method = 'GET';
		}
		$q_pos = strpos( $raw, '?' );
		$query = false === $q_pos ? '' : substr( $raw, $q_pos + 1 );

		// A GET carrying a nonce performs an action (activate, delete, trash) rather than
		// viewing a screen. Admin tokens are for viewing screens and posting forms only.
		if ( 'GET' === $method ) {
			$args = array();
			wp_parse_str( $query, $args );
			foreach ( array_keys( $args ) as $arg ) {
				if ( preg_match( '/nonce$/i', (string) $arg ) ) {
					return new WP_Error( 'wpxmcp_action_link', 'GET tokens cannot carry a nonce: that URL performs an action instead of showing a screen.', array( 'status' => 400 ) );
				}
			}
		}
		// Network admin reaches every site; not driven through this generic path.
		if ( 0 === strpos( $path, 'network/' ) && 'POST' === $method ) {
			return new WP_Error( 'wpxmcp_network_admin', 'Network admin forms are not submitted through admin tokens.', array( 'status' => 400 ) );
		}

		$user_id   = get_current_user_id();
		$index_key = 'wpxmcp_admin_idx_' . $user_id;
		$index     = get_transient( $index_key );
		$index     = is_array( $index ) ? $index : array();
		$now       = time();
		foreach ( $index as $hash => $expires ) {
			if ( $expires < $now || false === get_transient( 'wpxmcp_admin_tok_' . $hash ) ) {
				unset( $index[ $hash ] );
			}
		}
		if ( count( $index ) >= self::MAX_OUTSTANDING ) {
			return new WP_Error(
				'wpxmcp_admin_rate_limited',
				sprintf( 'You already hold %d unused admin tokens. Use them or wait %d seconds.', self::MAX_OUTSTANDING, self::TOKEN_TTL ),
				array( 'status' => 429 )
			);
		}

		$token = wp_generate_password( 32, false, false );
		$hash  = $this->hash_token( $token );

		// The wp-admin session is bound to a caller-chosen flow id: the requests of one
		// operation (render a form, post it, read the result) share it so the form's
		// nonce validates; without a flow every request gets its own session.
		$flow = (string) $request->get_param( 'flow' );
		if ( ! preg_match( '/^[A-Za-z0-9]{16,64}$/', $flow ) ) {
			$flow = $token;
		}

		set_transient( 'wpxmcp_admin_tok_' . $hash, array(
			'user_id' => $user_id,
			'path'    => $path,
			'query'   => $this->normalise_query( $query ),
			'method'  => $method,
			'flow'    => $flow,
			'created' => $now,
		), self::TOKEN_TTL );

		$index[ $hash ] = $now + self::TOKEN_TTL;
		set_transient( $index_key, $index, self::TOKEN_TTL + 60 );

		wpxmcp_audit( 'admin_token.issue', array( 'path' => $path, 'method' => $method ) );

		return array(
			'token'      => $token,
			'path'       => $path,
			'method'     => $method,
			'expires_in' => self::TOKEN_TTL,
			'note'       => 'Single use. Append ?' . self::PARAM . '=<token> to the wp-admin URL and request it with the bound method.',
		);
	}

	/* --------------------------------------------------------------------- */
	/* Tokenised front-end authentication                                    */
	/* --------------------------------------------------------------------- */

	/**
	 * Validate an admin-fetch token and, if it matches this request, authenticate
	 * as the issuing administrator for this request only.
	 *
	 * Invalid, expired, reused, or mis-bound tokens are ignored silently: the
	 * request proceeds exactly as it would without the parameter (wp-admin will
	 * then bounce an unauthenticated visitor to wp-login.php as usual).
	 *
	 * @param string $token Token from the query string.
	 */
	private function maybe_authenticate( $token ) {
		if ( ! preg_match( '/^[A-Za-z0-9]{32}$/', $token ) ) {
			return;
		}
		$hash = $this->hash_token( $token );
		$key  = 'wpxmcp_admin_tok_' . $hash;
		$req  = get_transient( $key );
		if ( ! is_array( $req ) || empty( $req['user_id'] ) ) {
			return;
		}
		// Single use: consumed before anything else can go wrong.
		delete_transient( $key );

		$request_uri    = isset( $_SERVER['REQUEST_URI'] ) ? (string) wp_unslash( $_SERVER['REQUEST_URI'] ) : ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		$request_path   = $this->admin_relative_path( $request_uri );
		$request_method = isset( $_SERVER['REQUEST_METHOD'] ) ? strtoupper( (string) $_SERVER['REQUEST_METHOD'] ) : 'GET'; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		$request_query  = (string) wp_parse_url( $request_uri, PHP_URL_QUERY );

		if ( is_wp_error( $request_path )
			|| $request_path !== $req['path']
			|| $request_method !== $req['method']
			|| $this->normalise_query( $request_query ) !== $req['query'] ) {
			return;
		}

		$user = get_userdata( (int) $req['user_id'] );
		if ( ! $user || ! user_can( $user, WPXMCP_ADMIN_CAP ) ) {
			return;
		}
		if ( is_multisite() && ! is_super_admin( $user->ID ) ) {
			return;
		}

		$this->authenticate_as( (int) $user->ID, isset( $req['flow'] ) ? (string) $req['flow'] : $token );
	}

	/**
	 * Authenticate the current request as $user_id without ever emitting a cookie,
	 * and hook the menu snapshot capture and session teardown.
	 *
	 * The wp-admin session token is derived from the user and the token's flow id.
	 * WordPress binds nonces to the session token, so the requests of one operation
	 * (the GET that renders a form and the POST that submits it) must share it;
	 * separate operations, and any request issued without a flow, get distinct
	 * sessions. The token is registered as a real session (so auth_redirect's
	 * wp_validate_auth_cookie passes) and destroyed at shutdown, so nothing
	 * lingers between requests.
	 *
	 * @param int    $user_id User id.
	 * @param string $flow    Flow id (defaults to the single-use request token).
	 */
	private function authenticate_as( $user_id, $flow ) {
		$this->acting_user   = $user_id;
		$expiration          = time() + self::TOKEN_TTL;
		$this->session_token = 'wpxmcp' . substr( hash_hmac( 'sha256', $user_id . '|' . $flow, wp_salt( 'auth' ) ), 0, 26 );

		// Register the deterministic token as a valid session for this request.
		$manager = WP_Session_Tokens::get_instance( $user_id );
		$manager->update( $this->session_token, array(
			'expiration' => $expiration,
			'login'      => time(),
			'ip'         => '127.0.0.1',
			'ua'         => 'wpxmcp',
		) );

		// Inject the auth cookies in-memory only, using our session token.
		if ( defined( 'AUTH_COOKIE' ) ) {
			$_COOKIE[ AUTH_COOKIE ] = wp_generate_auth_cookie( $user_id, $expiration, 'auth', $this->session_token );
		}
		if ( defined( 'SECURE_AUTH_COOKIE' ) ) {
			$_COOKIE[ SECURE_AUTH_COOKIE ] = wp_generate_auth_cookie( $user_id, $expiration, 'secure_auth', $this->session_token );
		}
		if ( defined( 'LOGGED_IN_COOKIE' ) ) {
			$_COOKIE[ LOGGED_IN_COOKIE ] = wp_generate_auth_cookie( $user_id, $expiration, 'logged_in', $this->session_token );
		}

		// Never send Set-Cookie to the client for this request.
		add_filter( 'send_auth_cookies', '__return_false', PHP_INT_MAX );
		// wp-admin also sets its own cookies (wp_user_settings() writes wp-settings-{id}),
		// and plugins may too. Strip every Set-Cookie right before headers go out, so
		// the fetcher never receives anything it could replay.
		if ( function_exists( 'header_register_callback' ) ) {
			header_register_callback( array( __CLASS__, 'strip_set_cookie' ) );
		}

		// Make the current user explicit as early as possible.
		add_filter( 'determine_current_user', function () use ( $user_id ) {
			return $user_id;
		}, PHP_INT_MAX );
		if ( did_action( 'set_current_user' ) ) {
			wp_set_current_user( $user_id );
		}

		// This response is private to the caller and must never be cached.
		if ( ! defined( 'DONOTCACHEPAGE' ) ) {
			define( 'DONOTCACHEPAGE', true );
		}
		add_action( 'send_headers', 'nocache_headers' );

		// Remove the spent token from the request so WordPress never echoes it into
		// _wp_http_referer fields, redirects or self-links.
		unset( $_GET[ self::PARAM ], $_REQUEST[ self::PARAM ] ); // phpcs:ignore WordPress.Security.NonceVerification
		if ( isset( $_SERVER['REQUEST_URI'] ) ) {
			$_SERVER['REQUEST_URI'] = remove_query_arg( self::PARAM, (string) $_SERVER['REQUEST_URI'] ); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
		}
		if ( isset( $_SERVER['QUERY_STRING'] ) ) {
			$qs = array();
			wp_parse_str( (string) $_SERVER['QUERY_STRING'], $qs ); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
			unset( $qs[ self::PARAM ] );
			$_SERVER['QUERY_STRING'] = http_build_query( $qs );
		}

		// Snapshot the admin menu once it is built.
		add_action( 'admin_menu', array( $this, 'capture_menu' ), PHP_INT_MAX );
		// options.php builds its option-group allowlist and filters it on every load;
		// keep a copy so a form submit can check it sends every option in its group.
		add_filter( 'allowed_options', array( $this, 'capture_allowed_options' ), PHP_INT_MAX );
		add_action( 'admin_init', array( $this, 'capture_menu' ), PHP_INT_MAX );

		// Tear the session down at the end of the request.
		add_action( 'shutdown', array( $this, 'destroy_session' ), PHP_INT_MAX );

		wpxmcp_audit( 'admin_fetch', array(
			'user'   => $user_id,
			'uri'    => isset( $_SERVER['REQUEST_URI'] ) ? esc_url_raw( (string) wp_unslash( $_SERVER['REQUEST_URI'] ) ) : '', // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
			'method' => isset( $_SERVER['REQUEST_METHOD'] ) ? strtoupper( (string) $_SERVER['REQUEST_METHOD'] ) : 'GET', // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		) );
	}

	/**
	 * Store the options.php allowlist (option group => option names) seen on a
	 * tokenised admin request. Returns the list unchanged.
	 *
	 * @param array $allowed Allowed options by group.
	 * @return array
	 */
	public function capture_allowed_options( $allowed ) {
		if ( is_array( $allowed ) ) {
			$groups = array();
			foreach ( $allowed as $group => $names ) {
				$groups[ (string) $group ] = array_values( array_map( 'strval', (array) $names ) );
			}
			set_transient( 'wpxmcp_allowed_options', array(
				'time'         => time(),
				'user_id'      => get_current_user_id(),
				'plugins_hash' => $this->active_plugins_hash(),
				'groups'       => $groups,
			), self::MENU_TTL );
		}
		return $allowed;
	}

	/**
	 * The options options.php will write for one option group (captured on the
	 * last tokenised load of options.php).
	 *
	 * @param WP_REST_Request $request Request.
	 * @return array
	 */
	public function rest_allowed_options( $request ) {
		$group  = (string) $request->get_param( 'option_page' );
		$stored = get_transient( 'wpxmcp_allowed_options' );
		if ( ! is_array( $stored ) || $stored['plugins_hash'] !== $this->active_plugins_hash() ) {
			return array( 'captured' => false, 'option_page' => $group, 'options' => null );
		}
		return array(
			'captured'    => true,
			'age'         => time() - (int) $stored['time'],
			'option_page' => $group,
			'group_known' => isset( $stored['groups'][ $group ] ),
			'options'     => isset( $stored['groups'][ $group ] ) ? $stored['groups'][ $group ] : null,
		);
	}

	/**
	 * Remove every Set-Cookie header from a tokenised admin response.
	 */
	public static function strip_set_cookie() {
		header_remove( 'Set-Cookie' );
	}

	/**
	 * Destroy the per-request wp-admin session so it never persists.
	 */
	public function destroy_session() {
		if ( $this->acting_user && '' !== $this->session_token ) {
			$manager = WP_Session_Tokens::get_instance( $this->acting_user );
			$manager->destroy( $this->session_token );
			$this->session_token = '';
		}
	}
}
